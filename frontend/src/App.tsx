import React, { useEffect, useState, useRef, useCallback } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

// --- Production Chart Component (Imperative Updates, Zero Re-renders, ResizeObserver) ---
const UPlotChart = React.memo(({ 
  options, 
  channelKey, 
  registerPlot 
}: { 
  options: any, 
  channelKey: string,
  registerPlot: (key: string, plot: uPlot) => void 
}) => {
  const chartRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    if (chartRef.current && !plotRef.current) {
      plotRef.current = new uPlot(options, [[], []], chartRef.current);
      registerPlot(channelKey, plotRef.current);
    }
  }, [options, channelKey, registerPlot]);

  // Responsive resize
  useEffect(() => {
    if (!chartRef.current || !plotRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (let entry of entries) {
        if (plotRef.current) {
          plotRef.current.setSize({
            width: entry.contentRect.width,
            height: 140
          });
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

const CHANNEL_COLORS = [
  "#4ec9b0", "#ce9178", "#dcdcaa", "#569cd6", "#c586c0", "#d16969", "#b5cea8"
];

export default function App() {
  const [activeTab, setActiveTab] = useState('live');
  const [connectionStatus, setConnectionStatus] = useState<'disconnected'|'connecting'|'connected'>('disconnected');
  const [recording, setRecording] = useState(false);
  
  // Hardware Selection State
  const [ports, setPorts] = useState<any[]>([]);
  const [selectedSource, setSelectedSource] = useState('simulator');

  const [stats, setStats] = useState({ hz: 0, pkts: 0 });
  const [timeStr, setTimeStr] = useState("0.00");
  const [experiments, setExperiments] = useState<any[]>([]);
  
  const [latestData, setLatestData] = useState<Record<string, number>>({});
  const channels = Object.keys(latestData);
  
  const MAX_POINTS = 1000;

  const dataArrays = useRef<Record<string, number[]>>({ t: [] });
  const plotsRef = useRef<Record<string, uPlot>>({});

  const wsRef = useRef<WebSocket | null>(null);
  const packetCounter = useRef(0);
  const lastTime = useRef(performance.now());
  const reconnectTimeout = useRef<number | null>(null);

  const fetchExperiments = async () => {
    try {
      const res = await fetch("http://localhost:8000/api/experiments");
      setExperiments(await res.json());
    } catch(e) {}
  };

  const fetchPorts = async () => {
    try {
      const res = await fetch("http://localhost:8000/api/ports");
      setPorts(await res.json());
    } catch(e) {}
  };

  useEffect(() => {
    if (activeTab === 'log') fetchExperiments();
    fetchPorts();
  }, [activeTab]);

  const clearGraphs = () => {
    Object.keys(dataArrays.current).forEach(k => {
      dataArrays.current[k] = [];
    });
    setTimeStr("0.00");
    setLatestData({});
    Object.keys(plotsRef.current).forEach(k => {
      plotsRef.current[k].setData([[], []]);
    });
  };

  const registerPlot = useCallback((key: string, plot: uPlot) => {
    plotsRef.current[key] = plot;
  }, []);

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
      
      const sensors = {
        ...parsed.sensors,
        "Power_W (Calc)": parsed.sensors.Load_N ? parsed.sensors.Load_N * 2.5 : 0
      };

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
    setChartData({});
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
      alert("Failed to connect to source.");
      setConnectionStatus('disconnected');
    }
  };

  const disconnectDevice = async () => {
    try {
      await fetch("http://localhost:8000/api/source/disconnect", { method: 'POST' });
    } catch (e) {}
    
    if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
    }
    setConnectionStatus('disconnected');
    setRecording(false);
  };

  const toggleRecording = async () => {
    try {
      const endpoint = recording ? "/api/record/stop" : "/api/record/start";
      await fetch(`http://localhost:8000${endpoint}`, { method: 'POST' });
      setRecording(!recording);
    } catch (e) {
      console.error("Recording toggle failed", e);
    }
  };

  useEffect(() => {
    let animFrame: number;
    const updateCharts = () => {
      if (connectionStatus === 'connected') {
        const tArr = dataArrays.current.t;
        Object.keys(plotsRef.current).forEach(ch => {
           const plot = plotsRef.current[ch];
           const data = dataArrays.current[ch];
           if (plot && data) {
             plot.setData([tArr, data]);
           }
        });
      }
      animFrame = requestAnimationFrame(updateCharts);
    };
    if (connectionStatus === 'connected') animFrame = requestAnimationFrame(updateCharts);
    return () => cancelAnimationFrame(animFrame);
  }, [connectionStatus]);

  const setChartData = (data: any) => {}; // Unused with imperative plotting, kept for compat

  const commonChartOpts = (label: string, color: string) => ({
    width: 600,
    height: 140,
    cursor: { drag: { x: true, y: true } },
    axes: [
      { stroke: "#ccc", grid: { stroke: "#333", width: 1 } },
      { stroke: "#ccc", grid: { stroke: "#333", width: 1 } }
    ],
    series: [
      {},
      { stroke: color, width: 1.5, label: label }
    ]
  });

  return (
    <div className="flex flex-col h-screen w-full bg-[#1e1e1e] text-[#cccccc] font-sans">
      
      {/* Top Toolbar */}
      <header className="h-10 flex items-center justify-between px-4 border-b border-[#333] bg-[#252526]">
        <div className="flex items-center gap-6 text-sm">
          <strong className="text-white">OpenBench Workspace</strong>
          <div className="flex gap-1 bg-[#1e1e1e] border border-[#333] p-0.5 rounded">
            <button 
              onClick={() => setActiveTab('live')} 
              className={`px-3 py-0.5 text-xs rounded transition-colors ${activeTab === 'live' ? 'bg-[#333] text-white' : 'text-[#888] hover:text-[#ccc]'}`}
            >
              Live Telemetry
            </button>
            <button 
              onClick={() => setActiveTab('log')} 
              className={`px-3 py-0.5 text-xs rounded transition-colors ${activeTab === 'log' ? 'bg-[#333] text-white' : 'text-[#888] hover:text-[#ccc]'}`}
            >
              Experiment Log & Export
            </button>
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs font-mono text-[#888]">
          {connectionStatus === 'connecting' && <span className="text-[#dcdcaa] animate-pulse">Reconnecting...</span>}
          {connectionStatus === 'disconnected' && <span className="text-[#d16969]">Offline</span>}
          <span>{stats.hz} Hz</span>
          <span>{stats.pkts} Pkts</span>
        </div>
      </header>

      {/* Main Workspace */}
      <main className="flex-1 flex overflow-hidden">
        
        {/* Left Sidebar */}
        <div className="w-64 border-r border-[#333] bg-[#252526] flex flex-col shrink-0">
          
          <div className="p-2 border-b border-[#333]">
            <h3 className="text-xs font-bold uppercase mb-2">Hardware Source</h3>
            <select 
              value={selectedSource}
              onChange={(e) => setSelectedSource(e.target.value)}
              disabled={connectionStatus === 'connected'}
              className="w-full bg-[#1e1e1e] border border-[#333] text-xs p-1 mb-2 text-white outline-none"
            >
              <option value="simulator">Math Simulator</option>
              <optgroup label="Real Hardware (COM Ports)">
                {ports.map(p => (
                  <option key={p.device} value={p.device}>{p.device} - {p.description}</option>
                ))}
                {ports.length === 0 && <option disabled>No COM ports detected</option>}
              </optgroup>
            </select>

            <div className="flex gap-2">
              <button 
                onClick={connectionStatus === 'connected' ? disconnectDevice : connectDevice}
                disabled={connectionStatus === 'connecting'}
                className={`flex-1 py-1 px-2 text-xs border transition-colors ${connectionStatus === 'connected' ? 'bg-[#333] border-[#555] hover:bg-[#444]' : 'bg-[#007acc] text-white border-[#007acc] hover:bg-[#005f9e]'}`}
              >
                {connectionStatus === 'connected' ? 'Disconnect' : connectionStatus === 'connecting' ? '...' : 'Connect'}
              </button>
              <button 
                onClick={clearGraphs}
                className="py-1 px-2 text-xs border bg-[#333] border-[#555] hover:bg-[#444] transition-colors"
                title="Restart Graphs"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="p-2 border-b border-[#333]">
            <h3 className="text-xs font-bold uppercase mb-2">Data Acquisition</h3>
            <button 
              onClick={toggleRecording}
              disabled={connectionStatus !== 'connected'}
              className={`w-full py-1 px-2 text-xs border mb-2 disabled:opacity-50 transition-colors ${recording ? 'bg-[#d13b3b] text-white border-[#d13b3b] hover:bg-[#c13030]' : 'bg-[#333] border-[#555] hover:bg-[#444]'}`}
            >
              {recording ? 'Stop Recording' : 'Start Recording (HDF5)'}
            </button>
            {recording && <div className="text-[10px] uppercase text-[#d13b3b] font-bold tracking-widest text-center animate-pulse">Logging to HDF5</div>}
          </div>

          <div className="p-2 flex-1 overflow-auto">
            <h3 className="text-xs font-bold uppercase mb-2 text-[#007acc]">Discovered Channels</h3>
            {channels.length === 0 && (
              <div className="text-xs text-[#666] italic">Awaiting data stream...</div>
            )}
            <table className="w-full text-left text-xs font-mono border-collapse">
              <tbody>
                <tr className="border-b border-[#333]">
                  <td className="py-1 text-[#888]">Time</td>
                  <td className="py-1 text-right">{timeStr} s</td>
                </tr>
                {channels.map((ch, idx) => (
                   <tr key={ch} className="border-b border-[#333]">
                     <td className="py-1 text-[#888]" style={{color: CHANNEL_COLORS[idx % CHANNEL_COLORS.length]}}>
                        {ch}
                     </td>
                     <td className="py-1 text-right text-white">
                        {latestData[ch] !== undefined ? latestData[ch].toFixed(3) : '---'}
                     </td>
                   </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto bg-[#1e1e1e]">
          
          {activeTab === 'live' && (
            <div className="p-4 flex flex-col gap-4">
              {channels.length === 0 ? (
                 <div className="flex flex-col gap-2 items-center justify-center h-64 text-[#666] text-sm uppercase tracking-widest border border-dashed border-[#333]">
                   <div>Plug in a device to auto-discover channels</div>
                   {connectionStatus !== 'connected' && <div className="text-xs text-[#dcdcaa]">(Select a source and click Connect)</div>}
                 </div>
              ) : (
                channels.map((ch, idx) => (
                  <div key={ch} className="border border-[#333] bg-[#1e1e1e] p-2 flex flex-col w-full">
                    <div className="text-xs font-bold mb-2 uppercase" style={{color: CHANNEL_COLORS[idx % CHANNEL_COLORS.length]}}>
                      {ch}
                    </div>
                    {/* The wrapper div for ResizeObserver */}
                    <div className="w-full h-[140px] relative">
                        <UPlotChart 
                          channelKey={ch}
                          registerPlot={registerPlot}
                          options={commonChartOpts(ch, CHANNEL_COLORS[idx % CHANNEL_COLORS.length])} 
                        />
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {activeTab === 'log' && (
            <div className="p-8 max-w-4xl">
              <h2 className="text-xl text-white mb-6">Experiment Log & Exports</h2>
              <table className="w-full text-left text-sm border-collapse border border-[#333]">
                <thead className="bg-[#252526]">
                  <tr>
                    <th className="p-3 border border-[#333]">ID</th>
                    <th className="p-3 border border-[#333]">Experiment Name</th>
                    <th className="p-3 border border-[#333]">Date</th>
                    <th className="p-3 border border-[#333]">HDF5 File</th>
                    <th className="p-3 border border-[#333]">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {experiments.map(e => (
                    <tr key={e.id} className="hover:bg-[#2a2a2b] transition-colors">
                      <td className="p-3 border border-[#333] font-mono text-[#888]">{e.id}</td>
                      <td className="p-3 border border-[#333]">{e.name}</td>
                      <td className="p-3 border border-[#333] text-[#888]">{new Date(parseInt(e.date)*1000).toLocaleString()}</td>
                      <td className="p-3 border border-[#333] font-mono text-xs text-[#888]">{e.file_path}</td>
                      <td className="p-3 border border-[#333]">
                        <a 
                          href={`http://localhost:8000/api/export/${e.id}`}
                          download
                          className="bg-[#007acc] hover:bg-[#005f9e] text-white px-3 py-1 rounded text-xs inline-block transition-colors"
                        >
                          Export to Excel (CSV)
                        </a>
                      </td>
                    </tr>
                  ))}
                  {experiments.length === 0 && (
                    <tr>
                      <td colSpan={5} className="p-6 text-center text-[#888]">No experiments recorded yet. Click 'Start Recording' in the Live tab!</td>
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
