import React, { useEffect, useState, useRef } from 'react';
import { useParams, useLocation } from 'wouter';
import { MessageBubble, FindingCard, SectionHeader, LoadingSpinner, GradientButton, StatBadge } from '@/components/PixarComponents';
import '../styles/pixar-theme.css';

interface Finding {
  id: string;
  type: 'algorithm' | 'crypto' | 'can' | 'checksum' | 'string' | 'key' | 'offset' | 'protocol';
  title: string;
  content: string;
  colorScheme: 'coral' | 'orange' | 'lime' | 'cyan' | 'purple' | 'magenta';
  timestamp: Date;
  icon: string;
}

export const AnalysisChat: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const [findings, setFindings] = useState<Finding[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [analysisData, setAnalysisData] = useState<any>(null);
  const [chatMessage, setChatMessage] = useState('');
  const [chatHistory, setChatHistory] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [findings, chatHistory]);

  // Fetch analysis data
  useEffect(() => {
    const fetchAnalysis = async () => {
      try {
        const response = await fetch(`/api/analysis/${id}`);
        if (!response.ok) throw new Error('Analysis not found');
        const data = await response.json();
        setAnalysisData(data);

        // Parse findings from agent results
        const parsedFindings: Finding[] = [];
        const colorSchemes: Array<'coral' | 'orange' | 'lime' | 'cyan' | 'purple' | 'magenta'> = [
          'coral',
          'orange',
          'lime',
          'cyan',
          'purple',
          'magenta',
        ];
        let colorIndex = 0;

        // Extract findings from agent results
        data.agentResults?.forEach((agent: any) => {
          const rawNotes = agent.rawNotes;
          if (rawNotes && typeof rawNotes === 'string') {
            try {
              const jsonMatch = rawNotes.match(/```json\n([\s\S]*?)\n```/);
              if (jsonMatch) {
                const findings_obj = JSON.parse(jsonMatch[1]);
                const agentFindings = findings_obj.findings || {};

                // Algorithms
                agentFindings.algorithms?.forEach((algo: any) => {
                  parsedFindings.push({
                    id: `algo-${algo.name}`,
                    type: 'algorithm',
                    title: algo.name,
                    content: `${algo.description}\n\nOffset: ${algo.offset}\nConfidence: ${algo.confidence}%\n\n${algo.pseudocode || ''}`,
                    colorScheme: colorSchemes[colorIndex % colorSchemes.length],
                    timestamp: new Date(agent.timestamp || Date.now()),
                    icon: '🔐',
                  });
                });

                // Crypto Constants
                agentFindings.cryptoConstants?.forEach((crypto: any) => {
                  parsedFindings.push({
                    id: `crypto-${crypto.name}`,
                    type: 'crypto',
                    title: crypto.name,
                    content: `Value: ${crypto.value}\nAlgorithm: ${crypto.algorithm}\nOffset: ${crypto.offset}`,
                    colorScheme: colorSchemes[(colorIndex + 1) % colorSchemes.length],
                    timestamp: new Date(agent.timestamp || Date.now()),
                    icon: '🔑',
                  });
                });

                // CAN Addresses
                agentFindings.canAddresses?.forEach((can: any) => {
                  parsedFindings.push({
                    id: `can-${can.module}`,
                    type: 'can',
                    title: `${can.module} - CAN Bus`,
                    content: `TX ID: ${can.txId}\nRX ID: ${can.rxId}\nProtocol: ${can.protocol}\n\n${can.description}`,
                    colorScheme: colorSchemes[(colorIndex + 2) % colorSchemes.length],
                    timestamp: new Date(agent.timestamp || Date.now()),
                    icon: '🚗',
                  });
                });

                // UDS Services
                agentFindings.udsServices?.forEach((uds: any) => {
                  parsedFindings.push({
                    id: `uds-${uds.serviceId}-${uds.subFunction}`,
                    type: 'protocol',
                    title: `UDS Service ${uds.serviceId} (${uds.subFunction})`,
                    content: `${uds.description}\n\nOffset: ${uds.offset}`,
                    colorScheme: colorSchemes[(colorIndex + 3) % colorSchemes.length],
                    timestamp: new Date(agent.timestamp || Date.now()),
                    icon: '📡',
                  });
                });

                colorIndex++;
              }
            } catch (e) {
              // Skip parsing errors
            }
          }
        });

        setFindings(parsedFindings);
        setIsLoading(false);
      } catch (error) {
        console.error('Failed to fetch analysis:', error);
        setIsLoading(false);
      }
    };

    if (id) {
      fetchAnalysis();
    }
  }, [id]);

  const handleSendMessage = async () => {
    if (!chatMessage.trim()) return;

    // Add user message to chat
    const newUserMessage = { role: 'user' as const, content: chatMessage };
    setChatHistory([...chatHistory, newUserMessage]);
    setChatMessage('');

    // Simulate AI response (in real implementation, call /api/analysis/:id/chat)
    setTimeout(() => {
      const assistantMessage = {
        role: 'assistant' as const,
        content: `I found ${findings.length} findings in this analysis. Based on your question about "${chatMessage}", here are the relevant discoveries...`,
      };
      setChatHistory((prev) => [...prev, assistantMessage]);
    }, 500);
  };

  if (isLoading) {
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100vh',
          backgroundColor: 'var(--color-bg-dark)',
        }}
      >
        <LoadingSpinner colorScheme="cyan" size="lg" />
      </div>
    );
  }

  return (
    <div
      style={{
        backgroundColor: 'var(--color-bg-secondary)',
        minHeight: '100vh',
        padding: 'var(--space-2xl)',
      }}
    >
      <div
        style={{
          maxWidth: '1200px',
          margin: '0 auto',
        }}
      >
        {/* Header */}
        <div style={{ marginBottom: 'var(--space-3xl)' }}>
          <button
            onClick={() => navigate('/analysis')}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--color-primary-cyan)',
              cursor: 'pointer',
              fontSize: 'var(--text-lg)',
              marginBottom: 'var(--space-lg)',
              transition: 'color var(--transition-fast)',
            }}
            onMouseEnter={(e) => {
              (e.target as HTMLElement).style.color = 'var(--color-primary-orange)';
            }}
            onMouseLeave={(e) => {
              (e.target as HTMLElement).style.color = 'var(--color-primary-cyan)';
            }}
          >
            ← Back to Analyses
          </button>

          <SectionHeader
            title={`${analysisData?.filename || 'Analysis'}`}
            subtitle={`${analysisData?.fileSize ? (analysisData.fileSize / 1024 / 1024).toFixed(2) : 'Unknown'} MB • ${findings.length} findings discovered`}
            colorScheme="cyan"
          />

          {/* Stats */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
              gap: 'var(--space-lg)',
              marginBottom: 'var(--space-2xl)',
            }}
          >
            <StatBadge label="Findings" value={findings.length} colorScheme="coral" />
            <StatBadge label="Algorithms" value={findings.filter((f) => f.type === 'algorithm').length} colorScheme="orange" />
            <StatBadge label="Crypto" value={findings.filter((f) => f.type === 'crypto').length} colorScheme="lime" />
            <StatBadge label="CAN Bus" value={findings.filter((f) => f.type === 'can').length} colorScheme="cyan" />
            <StatBadge label="Protocols" value={findings.filter((f) => f.type === 'protocol').length} colorScheme="purple" />
          </div>
        </div>

        {/* Findings Stream */}
        <div style={{ marginBottom: 'var(--space-3xl)' }}>
          <h3
            style={{
              color: 'var(--color-text-primary)',
              marginBottom: 'var(--space-lg)',
              fontSize: 'var(--text-2xl)',
            }}
          >
            📊 Extracted Findings
          </h3>
          <div>
            {findings.map((finding) => (
              <MessageBubble
                key={finding.id}
                content={
                  <FindingCard
                    title={finding.title}
                    content={finding.content}
                    icon={finding.icon}
                    colorScheme={finding.colorScheme}
                    expandable={true}
                  />
                }
                isUser={false}
                timestamp={finding.timestamp}
                colorScheme={finding.colorScheme}
              />
            ))}
          </div>
        </div>

        {/* Chat Interface */}
        <div
          style={{
            backgroundColor: 'var(--color-bg-primary)',
            borderRadius: 'var(--radius-2xl)',
            border: '2px solid var(--color-border-light)',
            padding: 'var(--space-xl)',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          <h3
            style={{
              color: 'var(--color-text-primary)',
              marginBottom: 'var(--space-lg)',
              fontSize: 'var(--text-xl)',
            }}
          >
            💬 Ask VENOM Anything
          </h3>

          {/* Chat History */}
          <div
            style={{
              maxHeight: '400px',
              overflowY: 'auto',
              marginBottom: 'var(--space-lg)',
              paddingRight: 'var(--space-md)',
              backgroundColor: 'var(--color-bg-secondary)',
              borderRadius: 'var(--radius-lg)',
              padding: 'var(--space-lg)',
            }}
          >
            {chatHistory.map((msg, idx) => (
              <MessageBubble
                key={idx}
                content={msg.content}
                isUser={msg.role === 'user'}
                colorScheme={msg.role === 'user' ? 'cyan' : 'lime'}
              />
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-md)',
            }}
          >
            <input
              type="text"
              value={chatMessage}
              onChange={(e) => setChatMessage(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
              placeholder="Ask about the findings, offsets, algorithms..."
              style={{
                flex: 1,
                backgroundColor: 'var(--color-bg-primary)',
                border: '2px solid var(--color-border)',
                borderRadius: 'var(--radius-lg)',
                padding: 'var(--space-md)',
                color: 'var(--color-text-primary)',
                fontSize: 'var(--text-base)',
                transition: 'border-color var(--transition-fast)',
              }}
              onFocus={(e) => {
                (e.target as HTMLElement).style.borderColor = 'var(--color-primary-teal)';
              }}
              onBlur={(e) => {
                (e.target as HTMLElement).style.borderColor = 'var(--color-border)';
              }}
            />
            <GradientButton
              gradient="cool"
              onClick={handleSendMessage}
              size="md"
            >
              Send
            </GradientButton>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AnalysisChat;
