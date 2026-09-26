import asyncio
import json
import time
import os
import math
import random
import h5py
import pandas as pd
import serial
import serial.tools.list_ports
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, BackgroundTasks, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy import create_engine, Column, Integer, String
from sqlalchemy.orm import declarative_base, sessionmaker
from contextlib import asynccontextmanager

# --- Database Setup ---
Base = declarative_base()
class Experiment(Base):
    __tablename__ = 'experiments'
    id = Column(Integer, primary_key=True)
    name = Column(String)
    date = Column(String)
    file_path = Column(String)

engine = create_engine('sqlite:///openbench.db', connect_args={"check_same_thread": False})
Base.metadata.create_all(bind=engine)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

os.makedirs("data", exist_ok=True)
os.makedirs("exports", exist_ok=True)

# --- Managers ---

class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def broadcast(self, message: str):
        for connection in self.active_connections:
            try:
                await connection.send_text(message)
            except Exception:
                pass

ui_manager = ConnectionManager()

class AsyncDataLogger:
    def __init__(self):
        self.is_recording = False
        self.h5_file = None
        self.datasets = {}
        self.queue = asyncio.Queue()
        self.worker_task = None

    async def start(self, exp_name: str):
        if self.is_recording: raise Exception("Already recording")
        timestamp = int(time.time())
        filename = f"data/exp_{timestamp}.h5"
        
        session = SessionLocal()
        exp = Experiment(name=exp_name, date=str(timestamp), file_path=filename)
        session.add(exp)
        session.commit()
        exp_id = exp.id
        session.close()

        self.h5_file = h5py.File(filename, 'w')
        self.datasets = {}
        self.is_recording = True
        self.worker_task = asyncio.create_task(self._write_worker())
        return exp_id

    async def stop(self):
        if not self.is_recording: return
        self.is_recording = False
        await self.queue.join()
        if self.worker_task:
            self.worker_task.cancel()
            self.worker_task = None
        if self.h5_file:
            self.h5_file.close()
            self.h5_file = None
            
    def enqueue_data(self, data: dict):
        if self.is_recording:
            self.queue.put_nowait(data)

    async def _write_worker(self):
        buffer = []
        try:
            while True:
                try:
                    data = await asyncio.wait_for(self.queue.get(), timeout=0.5)
                    buffer.append(data)
                    self.queue.task_done()
                except asyncio.TimeoutError:
                    pass
                if len(buffer) >= 50 or (buffer and self.queue.empty()):
                    self._flush_buffer(buffer)
                    buffer = []
        except asyncio.CancelledError:
            if buffer: self._flush_buffer(buffer)

    def _flush_buffer(self, buffer):
        if not self.h5_file: return
        if not self.datasets:
            self.datasets['time_s'] = self.h5_file.create_dataset('time_s', shape=(0,), maxshape=(None,), dtype='f8', chunks=True)
            for key in buffer[0]['sensors'].keys():
                self.datasets[key] = self.h5_file.create_dataset(key, shape=(0,), maxshape=(None,), dtype='f8', chunks=True)
        
        n = len(buffer)
        for key, dset in self.datasets.items():
            if key in self.datasets: dset.resize(dset.shape[0] + n, axis=0)
            
        self.datasets['time_s'][-n:] = [d.get('time_s', 0.0) for d in buffer]
        for key in self.datasets.keys():
            if key == 'time_s': continue
            self.datasets[key][-n:] = [d['sensors'].get(key, 0.0) for d in buffer]

logger = AsyncDataLogger()

class DataSourceManager:
    def __init__(self):
        self.active_task = None
        self.source_type = None # 'simulator' or 'serial'
        self.serial_conn = None

    async def start_simulator(self):
        await self.stop()
        self.source_type = 'simulator'
        self.active_task = asyncio.create_task(self._simulator_loop())

    async def start_serial(self, port: str, baudrate: int = 115200):
        await self.stop()
        try:
            self.serial_conn = serial.Serial(port, baudrate, timeout=0.1)
            self.source_type = 'serial'
            self.active_task = asyncio.create_task(self._serial_loop())
        except Exception as e:
            raise Exception(f"Failed to open port {port}: {str(e)}")

    async def stop(self):
        if self.active_task:
            self.active_task.cancel()
            try:
                await self.active_task
            except asyncio.CancelledError:
                pass
            self.active_task = None
        if self.serial_conn:
            self.serial_conn.close()
            self.serial_conn = None
        self.source_type = None

    async def _simulator_loop(self):
        t = 0
        try:
            while True:
                t += 0.016 
                data = {
                    "time_s": round(t, 4),
                    "sensors": {
                        "Load_N": round(100 + 50 * math.sin(2 * math.pi * 0.5 * t) + random.normalvariate(0, 1), 2),
                        "Temp_C": round(24.5 + t * 0.01 + random.normalvariate(0, 0.1), 2),
                        "Voltage_V": round(5.0 + random.normalvariate(0, 0.05), 3)
                    }
                }
                logger.enqueue_data(data)
                await ui_manager.broadcast(json.dumps(data))
                await asyncio.sleep(0.016)
        except asyncio.CancelledError:
            pass

    async def _serial_loop(self):
        t_start = time.time()
        try:
            while True:
                if self.serial_conn.in_waiting:
                    line = self.serial_conn.readline().decode('utf-8').strip()
                    if line:
                        try:
                            # Hardware sends: {"sensors": {"Laser_Dist": 5.4}}
                            parsed = json.loads(line)
                            if "sensors" in parsed:
                                data = {
                                    "time_s": round(time.time() - t_start, 4),
                                    "sensors": parsed["sensors"]
                                }
                                logger.enqueue_data(data)
                                await ui_manager.broadcast(json.dumps(data))
                        except json.JSONDecodeError:
                            pass # Ignore malformed serial lines
                await asyncio.sleep(0.001)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"Serial Error: {e}")

data_source = DataSourceManager()

@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await data_source.stop()
    await logger.stop()

app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

# --- REST API ---

@app.get("/api/ports")
def get_ports():
    ports = serial.tools.list_ports.comports()
    return [{"device": p.device, "description": p.description} for p in ports]

@app.post("/api/source/simulator")
async def connect_simulator():
    await data_source.start_simulator()
    return {"status": "Simulator connected"}

@app.post("/api/source/serial")
async def connect_serial(payload: dict): # {"port": "COM3"}
    port = payload.get("port")
    if not port: raise HTTPException(status_code=400, detail="Port missing")
    try:
        await data_source.start_serial(port)
        return {"status": f"Connected to {port}"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/source/disconnect")
async def disconnect_source():
    await data_source.stop()
    return {"status": "Disconnected"}

@app.get("/api/experiments")
def get_experiments():
    session = SessionLocal()
    exps = session.query(Experiment).all()
    session.close()
    return [{"id": e.id, "name": e.name, "date": e.date, "file_path": e.file_path} for e in exps]

@app.post("/api/record/start")
async def start_record():
    try:
        exp_id = await logger.start("Hardware Run")
        return {"status": "recording", "id": exp_id}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/record/stop")
async def stop_record():
    await logger.stop()
    return {"status": "stopped"}

@app.get("/api/export/{exp_id}")
def export_experiment(exp_id: int):
    session = SessionLocal()
    exp = session.query(Experiment).filter(Experiment.id == exp_id).first()
    session.close()
    if not exp or not os.path.exists(exp.file_path):
        raise HTTPException(status_code=404, detail="File not found")
        
    csv_path = f"exports/exp_{exp_id}.csv"
    if not os.path.exists(csv_path):
        try:
            with h5py.File(exp.file_path, 'r') as h5f:
                data = {key: h5f[key][:] for key in h5f.keys()}
                if not data: raise HTTPException(status_code=400, detail="Experiment file is empty")
                df = pd.DataFrame(data)
                df.to_csv(csv_path, index=False)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")
        
    return FileResponse(csv_path, media_type="text/csv", filename=f"{exp.name.replace(' ', '_')}_{exp.date}.csv")

# --- WebSocket UI Endpoint ---

@app.websocket("/ws/ui")
async def websocket_ui(websocket: WebSocket):
    await ui_manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text() # Keep connection alive
    except WebSocketDisconnect:
        ui_manager.disconnect(websocket)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
