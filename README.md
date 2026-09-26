# OpenBench

OpenBench is an open-source testing platform for physical hardware. It connects directly to any microcontroller via USB serial, streaming sensor data to a zero-lag React/FastAPI dashboard. It handles massive data ingestion seamlessly by plotting at 60Hz without freezing, logging everything to HDF5 binary files for clean, easy Excel exports.

![OpenBench Dashboard](https://raw.githubusercontent.com/swastikk594-hub/OpenBench/main/frontend/src/assets/hero.png) *(Note: Replace with actual screenshot link when available)*

## Features

- **Hardware Agnostic:** Plug in an Arduino, ESP32, Teensy, or any USB Serial DAQ. If it sends JSON over Serial, OpenBench plots it instantly.
- **Zero-Lag UI:** Built using `uPlot` (WebGL/Canvas) and imperative React updates. Handles thousands of data points per second with ~0% CPU utilization.
- **Scientific Grade Logging:** Data is streamed via asynchronous, non-blocking queues directly to **HDF5** binary files (the same format used by CERN and NASA).
- **One-Click Export:** Convert massive HDF5 binary logs into clean `.csv` files for Excel, MATLAB, or Pandas.
- **Auto-Discovery:** No need to hardcode UI elements. If your hardware sends a new variable (e.g., `"Pressure_PSI": 14.7`), the dashboard instantly discovers it and spawns a new real-time graph.

## Getting Started

### 1. Start the Backend (FastAPI)
The backend manages the serial connections, SQLite experiment database, and HDF5 data logging.

```bash
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python main.py
```
*(The backend will run on `http://localhost:8000`)*

### 2. Start the Frontend (React / Vite)
The frontend is the "Mission Control" dashboard.

```bash
cd frontend
npm install
npm run dev
```
*(The UI will run on `http://localhost:5173`)*

## Connecting Hardware

To connect custom hardware, simply program your microcontroller to print a JSON string over the Serial monitor (baudrate `115200`). 

**Arduino Example:**
```cpp
void setup() {
  Serial.begin(115200);
}

void loop() {
  float temp = readThermocouple();
  float load = readLoadCell();
  
  // Format as {"sensors": {"Key": Value}}
  Serial.print("{\"sensors\": {");
  Serial.print("\"Temp_C\": "); Serial.print(temp);
  Serial.print(", \"Load_N\": "); Serial.print(load);
  Serial.println("}}");
  
  delay(20); // 50Hz update rate
}
```

Then, open the OpenBench dashboard, select your COM Port from the **Hardware Source** dropdown, and click **Connect**.

## License
MIT License. Free for both academic and commercial engineering use.
