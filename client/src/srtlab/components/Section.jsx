import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Section.jsx — Collapsible job door section for the new 6-job navigation model.
 * Each job (READ, MARRY, KEYS, FLASH, LIVE, REFERENCE) is rendered as a Section.
 * 
 * Props:
 *   - jobId: string (e.g. 'read', 'marry', 'keys', 'flash', 'live', 'ref')
 *   - label: string (e.g. 'READ', 'MARRY', 'KEYS', 'FLASH', 'LIVE', 'REFERENCE')
 *   - sub: string (subtitle/description)
 *   - members: array of tab objects { id, l (label), s (sub-label) }
 *   - activeTabId: current active tab id
 *   - onSelectTab: callback(tabId)
 *   - accentColor: CSS color for the job accent
 *   - bgColor: CSS background color for the job
 */
export default function Section({
  jobId,
  label,
  sub,
  members,
  activeTabId,
  onSelectTab,
  accentColor = '#3b82f6',
  bgColor = 'rgba(59,130,246,0.12)',
}) {
  const [expanded, setExpanded] = useState(true);

  const isActive = members.some(m => m.id === activeTabId);

  return (
    <div className="mb-4">
      {/* Section header — clickable to toggle expansion */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 rounded-lg transition-colors"
        style={{
          backgroundColor: isActive ? bgColor : 'transparent',
          borderLeft: `3px solid ${isActive ? accentColor : 'transparent'}`,
        }}
      >
        <div className="flex-1 text-left">
          <div className="font-semibold text-sm" style={{ color: accentColor }}>
            {label}
          </div>
          <div className="text-xs text-gray-600 mt-0.5">
            {sub}
          </div>
        </div>
        <ChevronDown
          size={16}
          className="transition-transform"
          style={{
            transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
            color: accentColor,
          }}
        />
      </button>

      {/* Expanded member list */}
      {expanded && (
        <div className="mt-2 ml-4 space-y-1">
          {members.map(tab => (
            <button
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                activeTabId === tab.id
                  ? 'bg-white text-gray-900 font-medium'
                  : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              <div className="font-medium">{tab.l || tab.id}</div>
              {tab.s && <div className="text-xs text-gray-500 mt-0.5">{tab.s}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
