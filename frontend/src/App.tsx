import React, { useEffect, useState, useRef, useCallback } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

// --- Production Chart Component ---
const UPlotChart = React.memo(({ options, channelKey, registerPlot }: { options: any, channelKey: string, registerPlot: (key: string, plot: uPlot) => void }) => {
  const chartRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    if (chartRef.current && !plotRef.current) {
      plotRef.current = new uPlot(options, [[], []], chartRef.current);
      registerPlot(channelKey, plotRef.current);
    }
  }, [options, channelKey, registerPlot]);

  useEffect(() => {
    if (!chartRef.current || !plotRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (let entry of entries) {
        if (plotRef.current) {
          plotRef.current.setSize({ width: entry.contentRect.width, height: 140 });
        }
      }
    });
    observer.observe(chartRef.current.parentElement!);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      if (plotRef.current) {
         plotRef.current.destroy();
         plotRef.current = null;
      }
    };
  }, []);

  return <div ref={chartRef} className="w-full h-full overflow-hidden" />;
});

const CHANNEL_COLORS = ["#4ec9b0", "#ce9178", "#dcdcaa", "#569cd6", "#c586c0", "#d16969", "#b5cea8"];

export default function App() {
  const [activeTab, setActiveTab] = useState<'setup'|'calibration'|'live'|'log'>('setup');
  const [connectionStatus, setConnectionStatus] = useState<'disconnected'|'connecting'|'connected'>('disconnected');
  const [recording, setRecording] = useState(false);
  
  // Hardware & Experiment State
  const [ports, setPorts] = useState<any[]>([]);
  const [selectedSource, setSelectedSource] = useState('simulator');
  const [experiment, setExperiment] = useState<{id: string, name: string} | null>(null);
  const [expForm, setExpForm] = useState({ name: 'Test Run 1', description: 'Initial baseline', hardware_info: 'N/A' });
  const [calibrationData, setCalibrationData] = useState<Record<string, {name: string, unit: string, scale: number, offset: number}>>({});
  
  const [stats, setStats] = useState({ hz: 0, pkts: 0 });
  const [timeStr, setTimeStr] = useState("0.00");
  const [latestData, setLatestData] = useState<Record<string, number>>({});
  const channels = Object.keys(latestData);
  
  const MAX_POINTS = 1000;
  const dataArrays = useRef<Record<string, number[]>>({ t: [] });
  const plotsRef = useRef<Record<string, uPlot>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const packetCounter = useRef(0);
  const lastTime = useRef(performance.now());
  const reconnectTimeout = useRef<number | null>(null);

  useEffect(() => { 
    fetchPorts(); 
    if (activeTab === 'log') fetchExperiments();
  }, [activeTab]);

  const fetchPorts = async () => {
    try {
      const res = await fetch("http://localhost:8000/api/ports");
      setPorts(await res.json());
    } catch(e) {}
  };

  const fetchExperiments = async () => {
    try {
      const res = await fetch("http://localhost:8000/api/experiments");
      setExperiments(await res.json());
    } catch(e) {}
  };

  const createExperiment = async () => {
    try {
      const res = await fetch("http://localhost:8000/api/experiments", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(expForm)
      });
      const data = await res.json();
      setExperiment({ id: data.id, name: expForm.name });
      setActiveTab('calibration');
    } catch(e) {
      alert("Failed to create experiment");
    }
  };

  const saveCalibration = async () => {
    if (!experiment) return;
    try {
      const payload = Object.entries(calibrationData).map(([key, c]) => ({
        key, name: c.name, unit: c.unit, calibration_scale: c.scale, calibration_offset: c.offset
      }));
      await fetch(`http://localhost:8000/api/experiments/${experiment.id}/sensors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      setActiveTab('live');
    } catch (e) {
      alert("Failed to save calibration");
    }
  };

  const resetWorkspace = async () => {
    await disconnectDevice();
    setExperiment(null);
    setExpForm({ name: 'Test Run 1', description: 'Initial baseline', hardware_info: 'N/A' });
    clearGraphs();
    setActiveTab('setup');
  };

  const clearGraphs = () => {
    Object.keys(dataArrays.current).forEach(k => { dataArrays.current[k] = []; });
    setTimeStr("0.00");
    setLatestData({});
    Object.keys(plotsRef.current).forEach(k => { plotsRef.current[k].setData([[], []]); });
  };

  const registerPlot = useCallback((key: string, plot: uPlot) => { plotsRef.current[key] = plot; }, []);

  const initUIWebsocket = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;
    wsRef.current = new WebSocket("ws://localhost:8000/ws/ui");
    
    wsRef.current.onopen = () => {
       setConnectionStatus('connected');
       if (dataArrays.current.t.length === 0) setLatestData({});
    };

    wsRef.current.onclose = () => {
       setConnectionStatus('disconnected');
       setRecording(false);
       reconnectTimeout.current = window.setTimeout(() => {
         if (connectionStatus !== 'connected') initUIWebsocket();
       }, 3000);
    };

    wsRef.current.onmessage = (event) => {
      const parsed = JSON.parse(event.data);
      const t = parsed.time_s;
      
      packetCounter.current++;
      const now = performance.now();
      if (now - lastTime.current > 1000) {
        setStats(s => ({ hz: packetCounter.current, pkts: s.pkts + packetCounter.current }));
        packetCounter.current = 0;
        lastTime.current = now;
      }
      
      const sensors = parsed.sensors;

      if (now - (wsRef.current as any)._lastUiUpdate > 66 || !(wsRef.current as any)._lastUiUpdate) {
         (wsRef.current as any)._lastUiUpdate = now;
         setLatestData(sensors);
         setTimeStr(t.toFixed(2));
      }

      const currentKeys = Object.keys(sensors);
      currentKeys.forEach(k => {
        if (!dataArrays.current[k]) dataArrays.current[k] = [];
      });

      const arr = dataArrays.current;
      arr.t.push(t);
      currentKeys.forEach(k => arr[k].push(sensors[k]));

      if (arr.t.length > MAX_POINTS) {
        arr.t.shift();
        currentKeys.forEach(k => arr[k].shift());
      }
    };
  };

  const connectDevice = async () => {
    setConnectionStatus('connecting');
    dataArrays.current = { t: [] };
    setLatestData({});
    
    try {
      if (selectedSource === 'simulator') {
        await fetch("http://localhost:8000/api/source/simulator", { method: 'POST' });
      } else {
        await fetch("http://localhost:8000/api/source/serial", { 
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: selectedSource })
        });
      }
      initUIWebsocket();
    } catch (e) {
      alert("Failed to connect");
      setConnectionStatus('disconnected');
    }
  };

  const disconnectDevice = async () => {
    try { await fetch("http://localhost:8000/api/source/disconnect", { method: 'POST' }); } catch (e) {}
    if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
    if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
    setConnectionStatus('disconnected');
    setRecording(false);
  };

  const toggleRecording = async () => {
    let targetExp = experiment;
    if (!targetExp) {
      try {
        const res = await fetch("http://localhost:8000/api/experiments", {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Quick Record ' + new Date().toLocaleTimeString(), description: 'Auto-generated context', hardware_info: 'Auto' })
        });
        const data = await res.json();
        targetExp = { id: data.id, name: 'Quick Record' };
        setExperiment(targetExp);
      } catch(e) {
        return alert("Failed to auto-create experiment");
      }
    }
    
    try {
      if (recording) {
        await fetch(`http://localhost:8000/api/record/stop`, { method: 'POST' });
        setRecording(false);
      } else {
        await fetch(`http://localhost:8000/api/record/start`, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ exp_id: targetExp.id })
        });
        setRecording(true);
      }
    } catch (e) { console.error(e); }
  };

  useEffect(() => {
    let animFrame: number;
    const updateCharts = () => {
      if (connectionStatus === 'connected' && activeTab === 'live') {
        const tArr = dataArrays.current.t;
        Object.keys(plotsRef.current).forEach(ch => {
           const plot = plotsRef.current[ch];
           const data = dataArrays.current[ch];
           if (plot && data) plot.setData([tArr, data]);
        });
      }
      animFrame = requestAnimationFrame(updateCharts);
    };
    if (connectionStatus === 'connected') animFrame = requestAnimationFrame(updateCharts);
    return () => cancelAnimationFrame(animFrame);
  }, [connectionStatus, activeTab]);

  useEffect(() => {
      channels.forEach(ch => {
          if (!calibrationData[ch]) {
              setCalibrationData(prev => ({...prev, [ch]: { name: ch, unit: 'units', scale: 1.0, offset: 0.0 }}));
          }
      });
  }, [channels]);

  const commonChartOpts = (label: string, color: string) => ({
    width: 600, height: 140, cursor: { drag: { x: true, y: true } },
    axes: [{ stroke: "#ccc", grid: { stroke: "#333", width: 1 } }, { stroke: "#ccc", grid: { stroke: "#333", width: 1 } }],
    series: [{}, { stroke: color, width: 1.5, label: label }]
  });

  return (
    <div className="flex flex-col h-screen w-full bg-[#1e1e1e] text-[#cccccc] font-sans">
      <header className="h-10 flex items-center justify-between px-4 border-b border-[#333] bg-[#252526]">
        <div className="flex items-center gap-6 text-sm">
          <strong className="text-white">OpenBench Workspace</strong>
          <div className="flex gap-1 bg-[#1e1e1e] border border-[#333] p-0.5 rounded">
            {['setup', 'calibration', 'live', 'log'].map(tab => (
              <button 
                key={tab} onClick={() => setActiveTab(tab as any)} 
                className={`px-3 py-0.5 text-xs rounded transition-colors uppercase font-bold tracking-wider ${activeTab === tab ? 'bg-[#333] text-white' : 'text-[#888] hover:text-[#ccc]'}`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs font-mono text-[#888]">
          {experiment && <span className="text-white bg-[#007acc] px-2 py-0.5 rounded">Exp: {experiment.name}</span>}
          {connectionStatus === 'connecting' && <span className="text-[#dcdcaa] animate-pulse">Reconnecting...</span>}
          {connectionStatus === 'disconnected' && <span className="text-[#d16969]">Offline</span>}
          <span>{stats.hz} Hz</span>
          <span>{stats.pkts} Pkts</span>
          <button onClick={resetWorkspace} className="ml-2 bg-[#d13b3b] hover:bg-[#c13030] text-white px-3 py-1 rounded transition-colors font-sans">
            Reset Workspace
          </button>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        
        {/* Persistent Left Sidebar - Connection & Acquisition */}
        <div className="w-64 border-r border-[#333] bg-[#252526] flex flex-col shrink-0">
          <div className="p-2 border-b border-[#333]">
            <h3 className="text-xs font-bold uppercase mb-2">Hardware Source</h3>
            <select 
              value={selectedSource} onChange={(e) => setSelectedSource(e.target.value)} disabled={connectionStatus === 'connected'}
              className="w-full bg-[#1e1e1e] border border-[#333] text-xs p-1 mb-2 text-white outline-none"
            >
              <option value="simulator">Math Simulator</option>
              <optgroup label="Real Hardware (COM Ports)">
                {ports.map(p => <option key={p.device} value={p.device}>{p.device} - {p.description}</option>)}
                {ports.length === 0 && <option disabled>No COM ports detected</option>}
              </optgroup>
            </select>
            <div className="flex gap-2">
              <button 
                onClick={connectionStatus === 'connected' ? disconnectDevice : connectDevice} disabled={connectionStatus === 'connecting'}
                className={`flex-1 py-1 px-2 text-xs border transition-colors ${connectionStatus === 'connected' ? 'bg-[#333] border-[#555] hover:bg-[#444]' : 'bg-[#007acc] text-white border-[#007acc] hover:bg-[#005f9e]'}`}
              >
                {connectionStatus === 'connected' ? 'Disconnect' : connectionStatus === 'connecting' ? '...' : 'Connect Hardware'}
              </button>
            </div>
          </div>

          <div className="p-2 border-b border-[#333]">
            <h3 className="text-xs font-bold uppercase mb-2">Data Acquisition</h3>
            <button 
              onClick={toggleRecording} disabled={connectionStatus !== 'connected'}
              className={`w-full py-1 px-2 text-xs border mb-2 disabled:opacity-50 transition-colors ${recording ? 'bg-[#d13b3b] text-white border-[#d13b3b] hover:bg-[#c13030]' : 'bg-[#333] border-[#555] hover:bg-[#444]'}`}
            >
              {recording ? 'Stop Recording' : 'Start Recording (HDF5)'}
            </button>
            {recording && <div className="text-[10px] uppercase text-[#d13b3b] font-bold tracking-widest text-center animate-pulse">Logging to HDF5</div>}
          </div>

          <div className="p-2 flex-1 overflow-auto">
            <h3 className="text-xs font-bold uppercase mb-2 text-[#007acc]">Discovered Channels</h3>
            {channels.length === 0 && <div className="text-xs text-[#666] italic">Awaiting data stream...</div>}
            <table className="w-full text-left text-xs font-mono border-collapse">
              <tbody>
                <tr className="border-b border-[#333]">
                  <td className="py-1 text-[#888]">Time</td>
                  <td className="py-1 text-right">{timeStr} s</td>
                </tr>
                {channels.map((ch, idx) => (
                   <tr key={ch} className="border-b border-[#333]">
                     <td className="py-1 text-[#888]" style={{color: CHANNEL_COLORS[idx % CHANNEL_COLORS.length]}}>{ch}</td>
                     <td className="py-1 text-right text-white">{latestData[ch] !== undefined ? latestData[ch].toFixed(3) : '---'}</td>
                   </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto bg-[#1e1e1e]">
          
          {activeTab === 'setup' && (
            <div className="p-8 max-w-2xl">
              <h2 className="text-2xl text-white mb-2">1. Define Experiment Context</h2>
              <p className="text-[#888] mb-6 text-sm">Every dataset in OpenBench is tied to an experimental context. Define what you are testing so the resulting HDF5 binary file remains reproducible.</p>
              <div className="flex flex-col gap-4">
                  <input type="text" placeholder="Experiment Name (e.g. 'Rear Wing V4 Test')" value={expForm.name} onChange={e => setExpForm({...expForm, name: e.target.value})} className="bg-[#252526] border border-[#333] p-2 text-white outline-none w-full" />
                  <textarea placeholder="Detailed Description / Test Conditions" value={expForm.description} onChange={e => setExpForm({...expForm, description: e.target.value})} className="bg-[#252526] border border-[#333] p-2 text-white outline-none w-full h-32" />
                  <input type="text" placeholder="Hardware Configuration / DAQ Unit" value={expForm.hardware_info} onChange={e => setExpForm({...expForm, hardware_info: e.target.value})} className="bg-[#252526] border border-[#333] p-2 text-white outline-none w-full" />
                  <button onClick={createExperiment} className="bg-[#007acc] text-white py-2 px-4 w-fit hover:bg-[#005f9e] transition-colors mt-4">Create Experiment Context &rarr;</button>
              </div>
            </div>
          )}

          {activeTab === 'calibration' && (
            <div className="p-8 max-w-4xl">
              <h2 className="text-2xl text-white mb-2">2. Sensor Calibration & Discovery</h2>
              <p className="text-[#888] mb-6 text-sm">
                Ensure your hardware is connected. Discovered raw channels will appear below. 
                Apply calibration multipliers (Scale) and offsets to convert raw ADC values (e.g., Volts) into physical units (e.g., PSI, Newtons).
                <strong> Both raw and calibrated values will be permanently logged to HDF5.</strong>
              </p>
              
              {channels.length === 0 ? (
                  <div className="bg-[#252526] border border-[#333] p-6 text-center text-[#888]">
                      No channels detected. Please connect hardware on the left sidebar to begin discovery.
                  </div>
              ) : (
                  <table className="w-full text-left text-sm border-collapse border border-[#333]">
                      <thead className="bg-[#252526]">
                          <tr>
                              <th className="p-2 border border-[#333]">Raw Hardware Key</th>
                              <th className="p-2 border border-[#333]">Semantic Name</th>
                              <th className="p-2 border border-[#333]">Unit</th>
                              <th className="p-2 border border-[#333]">Scale (Multiplier)</th>
                              <th className="p-2 border border-[#333]">Offset (+/-)</th>
                          </tr>
                      </thead>
                      <tbody>
                          {channels.map(ch => {
                              const c = calibrationData[ch] || {name: ch, unit: 'units', scale: 1, offset: 0};
                              return (
                                  <tr key={ch}>
                                      <td className="p-2 border border-[#333] font-mono text-xs">{ch}</td>
                                      <td className="p-2 border border-[#333]"><input className="bg-transparent text-white w-full border-b border-[#555] outline-none" value={c.name} onChange={e => setCalibrationData({...calibrationData, [ch]: {...c, name: e.target.value}})} /></td>
                                      <td className="p-2 border border-[#333]"><input className="bg-transparent text-white w-24 border-b border-[#555] outline-none" value={c.unit} onChange={e => setCalibrationData({...calibrationData, [ch]: {...c, unit: e.target.value}})} /></td>
                                      <td className="p-2 border border-[#333]"><input type="number" step="0.01" className="bg-transparent text-white w-24 border-b border-[#555] outline-none" value={c.scale} onChange={e => setCalibrationData({...calibrationData, [ch]: {...c, scale: parseFloat(e.target.value)}})} /></td>
                                      <td className="p-2 border border-[#333]"><input type="number" step="0.01" className="bg-transparent text-white w-24 border-b border-[#555] outline-none" value={c.offset} onChange={e => setCalibrationData({...calibrationData, [ch]: {...c, offset: parseFloat(e.target.value)}})} /></td>
                                  </tr>
                              );
                          })}
                      </tbody>
                  </table>
              )}
              <div className="mt-6 flex justify-end">
                  <button onClick={saveCalibration} disabled={channels.length === 0} className="bg-[#007acc] disabled:opacity-50 text-white py-2 px-6 hover:bg-[#005f9e] transition-colors">Lock Calibration & Start Dashboard &rarr;</button>
              </div>
            </div>
          )}

          {activeTab === 'live' && (
            <div className="p-4 flex flex-col gap-4">
              {!experiment && <div className="bg-[#252526] p-3 text-center text-[#dcdcaa] border border-[#dcdcaa] text-xs rounded">Note: You are viewing live data without an Experiment Context. Click 'Start Recording' on the left to auto-generate one, or go to Setup to define it properly.</div>}
              {channels.length === 0 ? (
                 <div className="flex flex-col gap-2 items-center justify-center h-64 text-[#666] text-sm uppercase tracking-widest border border-dashed border-[#333]">
                   <div>Plug in a device to auto-discover channels</div>
                 </div>
              ) : (
                channels.map((ch, idx) => (
                  <div key={ch} className="border border-[#333] bg-[#1e1e1e] p-2 flex flex-col w-full">
                    <div className="flex justify-between items-center mb-2">
                        <div className="text-xs font-bold uppercase" style={{color: CHANNEL_COLORS[idx % CHANNEL_COLORS.length]}}>
                        {calibrationData[ch]?.name || ch} <span className="text-[#666] font-normal lowercase">({calibrationData[ch]?.unit || 'raw'})</span>
                        </div>
                        <div className="text-[10px] text-[#666] font-mono">Cal: y = x*{calibrationData[ch]?.scale || 1} + {calibrationData[ch]?.offset || 0}</div>
                    </div>
                    <div className="w-full h-[140px] relative">
                        <UPlotChart channelKey={ch} registerPlot={registerPlot} options={commonChartOpts(ch, CHANNEL_COLORS[idx % CHANNEL_COLORS.length])} />
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {activeTab === 'log' && (
            <div className="p-8 max-w-4xl">
              <h2 className="text-2xl text-white mb-6">Experiment Log & Exports</h2>
              <table className="w-full text-left text-sm border-collapse border border-[#333]">
                <thead className="bg-[#252526]">
                  <tr>
                    <th className="p-3 border border-[#333]">Context</th>
                    <th className="p-3 border border-[#333]">Description</th>
                    <th className="p-3 border border-[#333]">Date</th>
                    <th className="p-3 border border-[#333]">HDF5 File</th>
                    <th className="p-3 border border-[#333]">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {experiments.map(e => (
                    <tr key={e.id} className="hover:bg-[#2a2a2b] transition-colors">
                      <td className="p-3 border border-[#333]">{e.name}</td>
                      <td className="p-3 border border-[#333] text-xs text-[#888] truncate max-w-[200px]">{e.description}</td>
                      <td className="p-3 border border-[#333] text-[#888]">{new Date(e.created_at * 1000).toLocaleString()}</td>
                      <td className="p-3 border border-[#333] font-mono text-xs text-[#888]">{e.file_path || 'Pending...'}</td>
                      <td className="p-3 border border-[#333]">
                        {e.file_path ? (
                          <a 
                            href={`http://localhost:8000/api/export/${e.id}`}
                            download
                            className="bg-[#007acc] hover:bg-[#005f9e] text-white px-3 py-1 rounded text-xs inline-block transition-colors"
                          >
                            Export CSV
                          </a>
                        ) : (
                          <span className="text-[#888] text-xs">No Data</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {experiments.length === 0 && (
                    <tr>
                      <td colSpan={5} className="p-6 text-center text-[#888]">No experiments recorded yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

        </div>
      </main>
    </div>
  );
}
