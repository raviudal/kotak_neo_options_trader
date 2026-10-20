import React, { useState, useRef } from 'react';

export default function PayoffGraph({ 
  curve = [], 
  spotPrice = 25100, 
  breakevens = [], 
  maxProfit = null, 
  maxLoss = null,
  strikes = []
}) {
  const [hoveredPoint, setHoveredPoint] = useState(null);
  const svgRef = useRef(null);

  if (!curve || curve.length === 0) {
    return (
      <div className="h-48 flex items-center justify-center bg-[#f4f4f0] border-2 border-black rounded-xl text-neutral-500 font-bold text-xs">
        No payoff data available for current legs.
      </div>
    );
  }

  // SVG canvas dimensions
  const width = 640;
  const height = 230;
  const padLeft = 55;
  const padRight = 35;
  const padTop = 30;
  const padBottom = 35;

  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;

  // Domain & Range calculations
  const spots = curve.map(c => c.spot);
  const minSpot = Math.min(...spots);
  const maxSpot = Math.max(...spots);
  const spotSpan = maxSpot - minSpot || 1;

  const pnls = curve.map(c => c.pnl);
  const rawMinPnl = Math.min(...pnls);
  const rawMaxPnl = Math.max(...pnls);
  const maxAbsPnl = Math.max(Math.abs(rawMinPnl), Math.abs(rawMaxPnl), 1000);
  const yMin = -maxAbsPnl * 1.15;
  const yMax = maxAbsPnl * 1.15;
  const ySpan = yMax - yMin || 1;

  const toX = (s) => padLeft + ((s - minSpot) / spotSpan) * innerW;
  const toY = (p) => padTop + innerH - ((p - yMin) / ySpan) * innerH;

  const zeroY = toY(0);

  // SVG Line path
  const linePoints = curve.map(c => `${toX(c.spot).toFixed(1)},${toY(c.pnl).toFixed(1)}`).join(' ');

  // Create area paths for Profit (above 0) and Loss (below 0)
  // Polygon closed by zero line
  const areaPoints = `${toX(curve[0].spot).toFixed(1)},${zeroY.toFixed(1)} ` +
    linePoints + ` ${toX(curve[curve.length - 1].spot).toFixed(1)},${zeroY.toFixed(1)}`;

  // Mouse move handler for interactive crosshair
  const handleMouseMove = (e) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const relX = (mouseX / rect.width) * width;
    
    // Find closest spot
    let closest = curve[0];
    let minD = 999999;
    for (const pt of curve) {
      const ptX = toX(pt.spot);
      const d = Math.abs(ptX - relX);
      if (d < minD) {
        minD = d;
        closest = pt;
      }
    }
    setHoveredPoint(closest);
  };

  const handleMouseLeave = () => {
    setHoveredPoint(null);
  };

  // Spot marker coordinates
  const currentSpotX = toX(spotPrice);
  const clampedSpotX = Math.max(padLeft, Math.min(width - padRight, currentSpotX));

  return (
    <div className="relative bg-white border border-slate-200 rounded-lg p-2.5 shadow-sm">
      
      {/* Top Legend / Status Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono pb-2 border-b border-slate-100">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 font-semibold text-slate-700">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block"></span>
            Profit Zone
          </span>
          <span className="flex items-center gap-1 font-semibold text-slate-700">
            <span className="w-2.5 h-2.5 rounded-full bg-rose-500 inline-block"></span>
            Loss Zone
          </span>
          <span className="flex items-center gap-1 font-semibold text-slate-700">
            <span className="w-2.5 h-2.5 rounded-full bg-blue-600 inline-block"></span>
            P&L Curve
          </span>
        </div>

        {/* Hover Readout Tooltip */}
        {hoveredPoint ? (
          <div className="bg-slate-900 text-white px-2 py-0.5 rounded font-mono font-bold text-[11px] shadow-sm">
            Nifty: <strong>{hoveredPoint.spot.toFixed(0)}</strong> → P&L: <strong>{hoveredPoint.pnl >= 0 ? '+' : ''}₹{hoveredPoint.pnl.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</strong>
          </div>
        ) : (
          <div className="text-[10px] text-slate-400 font-medium">
            Hover over chart for P&L at spot
          </div>
        )}
      </div>

      {/* Responsive SVG Graph */}
      <div className="w-full overflow-hidden mt-1 cursor-crosshair">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-auto select-none"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          <defs>
            {/* Clip path above zero for green fill */}
            <clipPath id="profit-clip">
              <rect x={padLeft} y={padTop} width={innerW} height={Math.max(0, zeroY - padTop)} />
            </clipPath>
            {/* Clip path below zero for red fill */}
            <clipPath id="loss-clip">
              <rect x={padLeft} y={zeroY} width={innerW} height={Math.max(0, height - padBottom - zeroY)} />
            </clipPath>
          </defs>

          {/* Background Grid Lines (Horizontal PnL guides) */}
          <line
            x1={padLeft}
            y1={toY(yMax * 0.5)}
            x2={width - padRight}
            y2={toY(yMax * 0.5)}
            stroke="#e5e5e5"
            strokeDasharray="3 3"
          />
          <line
            x1={padLeft}
            y1={toY(yMin * 0.5)}
            x2={width - padRight}
            y2={toY(yMin * 0.5)}
            stroke="#e5e5e5"
            strokeDasharray="3 3"
          />

          {/* Zero P&L Baseline */}
          <line
            x1={padLeft}
            y1={zeroY}
            x2={width - padRight}
            y2={zeroY}
            stroke="#000000"
            strokeWidth="1.5"
            strokeDasharray="4 4"
          />
          <text
            x={padLeft - 6}
            y={zeroY + 3.5}
            textAnchor="end"
            fontSize="10"
            fontWeight="bold"
            fill="#000000"
            fontFamily="monospace"
          >
            ₹0
          </text>

          {/* Upper & Lower Y-Axis Labels */}
          <text
            x={padLeft - 6}
            y={padTop + 10}
            textAnchor="end"
            fontSize="9"
            fontWeight="bold"
            fill="#15803d"
            fontFamily="monospace"
          >
            +₹{(yMax * 0.8).toFixed(0)}
          </text>
          <text
            x={padLeft - 6}
            y={height - padBottom - 2}
            textAnchor="end"
            fontSize="9"
            fontWeight="bold"
            fill="#b91c1c"
            fontFamily="monospace"
          >
            -₹{Math.abs(yMin * 0.8).toFixed(0)}
          </text>

          {/* Green Area Fill (Profit) */}
          <polygon
            points={areaPoints}
            fill="#a3e635"
            opacity="0.35"
            clipPath="url(#profit-clip)"
          />

          {/* Red Area Fill (Loss) */}
          <polygon
            points={areaPoints}
            fill="#ff4d4d"
            opacity="0.3"
            clipPath="url(#loss-clip)"
          />

          {/* Main P&L Curve - Distinct Royal Blue matching legend */}
          <polyline
            fill="none"
            stroke="#2563eb"
            strokeWidth="3.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={linePoints}
          />

          {/* Breakeven Vertical Lines */}
          {breakevens.map((be, idx) => {
            const bx = toX(be);
            if (bx < padLeft || bx > width - padRight) return null;
            return (
              <g key={`be-${idx}`}>
                <line
                  x1={bx}
                  y1={padTop}
                  x2={bx}
                  y2={height - padBottom}
                  stroke="#000000"
                  strokeWidth="1.5"
                  strokeDasharray="3 3"
                />
                <circle cx={bx} cy={zeroY} r="4" fill="#ffc900" stroke="#000000" strokeWidth="1.5" />
                <rect
                  x={bx - 26}
                  y={height - padBottom + 4}
                  width="52"
                  height="16"
                  rx="4"
                  fill="#ffffff"
                  stroke="#000000"
                  strokeWidth="1.5"
                />
                <text
                  x={bx}
                  y={height - padBottom + 16}
                  textAnchor="middle"
                  fontSize="9"
                  fontWeight="bold"
                  fill="#000000"
                  fontFamily="monospace"
                >
                  BE {be.toFixed(0)}
                </text>
              </g>
            );
          })}

          {/* Current Nifty Spot Vertical Line */}
          {currentSpotX >= padLeft && currentSpotX <= width - padRight && (
            <g>
              <line
                x1={currentSpotX}
                y1={padTop}
                x2={currentSpotX}
                y2={height - padBottom}
                stroke="#ff90e8"
                strokeWidth="2.5"
              />
              <rect
                x={clampedSpotX - 35}
                y={padTop - 22}
                width="70"
                height="18"
                rx="5"
                fill="#ff90e8"
                stroke="#000000"
                strokeWidth="1.5"
              />
              <text
                x={clampedSpotX}
                y={padTop - 10}
                textAnchor="middle"
                fontSize="9"
                fontWeight="900"
                fill="#000000"
                fontFamily="monospace"
              >
                SPOT {spotPrice.toFixed(0)}
              </text>
            </g>
          )}

          {/* Crosshair on Hover */}
          {hoveredPoint && (
            <g>
              <line
                x1={toX(hoveredPoint.spot)}
                y1={padTop}
                x2={toX(hoveredPoint.spot)}
                y2={height - padBottom}
                stroke="#000000"
                strokeWidth="1"
                strokeDasharray="2 2"
              />
              <circle
                cx={toX(hoveredPoint.spot)}
                cy={toY(hoveredPoint.pnl)}
                r="5"
                fill={hoveredPoint.pnl >= 0 ? '#a3e635' : '#ff4d4d'}
                stroke="#000000"
                strokeWidth="2"
              />
            </g>
          )}

          {/* X-Axis Strike / Spot Labels at Bottom */}
          <line
            x1={padLeft}
            y1={height - padBottom}
            x2={width - padRight}
            y2={height - padBottom}
            stroke="#000000"
            strokeWidth="1.5"
          />
          <text
            x={padLeft}
            y={height - padBottom + 16}
            textAnchor="start"
            fontSize="9"
            fontWeight="bold"
            fill="#525252"
            fontFamily="monospace"
          >
            {minSpot.toFixed(0)}
          </text>
          <text
            x={width - padRight}
            y={height - padBottom + 16}
            textAnchor="end"
            fontSize="9"
            fontWeight="bold"
            fill="#525252"
            fontFamily="monospace"
          >
            {maxSpot.toFixed(0)}
          </text>
        </svg>
      </div>
    </div>
  );
}
