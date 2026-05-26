import React from 'react';
import '../styles/pixar-theme.css';

/* ============================================
   PIXAR THEME COMPONENTS
   Reusable UI building blocks with warm, inviting Pixar aesthetic
   ============================================ */

// Message Bubble - For chat-like interface
export const MessageBubble = ({
  content,
  isUser = false,
  timestamp,
  colorScheme = 'cyan',
}: {
  content: React.ReactNode;
  isUser?: boolean;
  timestamp?: Date;
  colorScheme?: 'coral' | 'orange' | 'lime' | 'cyan' | 'purple' | 'magenta';
}) => {
  const colorMap = {
    coral: 'var(--color-primary-coral)',
    orange: 'var(--color-primary-peach)',
    lime: 'var(--color-primary-lime)',
    cyan: 'var(--color-primary-teal)',
    purple: 'var(--color-primary-purple)',
    magenta: 'var(--color-primary-rose)',
  };

  return (
    <div
      className="animate-slide-in-up"
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        marginBottom: 'var(--space-lg)',
        gap: 'var(--space-md)',
      }}
    >
      <div
        style={{
          maxWidth: '80%',
          backgroundColor: isUser ? 'var(--color-bg-tertiary)' : `rgba(45, 212, 191, 0.08)`,
          border: `2px solid ${colorMap[colorScheme]}`,
          borderRadius: 'var(--radius-2xl)',
          padding: 'var(--space-lg)',
          boxShadow: 'var(--shadow-sm)',
          transition: 'all var(--transition-base)',
        }}
      >
        <div style={{ color: 'var(--color-text-primary)', lineHeight: 1.6 }}>
          {content}
        </div>
        {timestamp && (
          <div
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--color-text-muted)',
              marginTop: 'var(--space-sm)',
            }}
          >
            {timestamp.toLocaleTimeString()}
          </div>
        )}
      </div>
    </div>
  );
};

// Finding Card - For displaying extracted data
export const FindingCard = ({
  title,
  content,
  icon,
  colorScheme = 'cyan',
  expandable = false,
}: {
  title: string;
  content: React.ReactNode;
  icon?: React.ReactNode;
  colorScheme?: 'coral' | 'orange' | 'lime' | 'cyan' | 'purple' | 'magenta';
  expandable?: boolean;
}) => {
  const [isExpanded, setIsExpanded] = React.useState(!expandable);

  const colorMap = {
    coral: { bg: 'var(--color-primary-coral)', light: 'rgba(255, 127, 107, 0.1)' },
    orange: { bg: 'var(--color-primary-peach)', light: 'rgba(255, 154, 118, 0.1)' },
    lime: { bg: 'var(--color-primary-lime)', light: 'rgba(107, 203, 119, 0.1)' },
    cyan: { bg: 'var(--color-primary-teal)', light: 'rgba(45, 212, 191, 0.1)' },
    purple: { bg: 'var(--color-primary-purple)', light: 'rgba(184, 159, 217, 0.1)' },
    magenta: { bg: 'var(--color-primary-rose)', light: 'rgba(255, 107, 157, 0.1)' },
  };

  return (
    <div
      className="animate-scale-in"
      style={{
        backgroundColor: colorMap[colorScheme].light,
        border: `2px solid ${colorMap[colorScheme].bg}`,
        borderRadius: 'var(--radius-xl)',
        padding: 'var(--space-lg)',
        marginBottom: 'var(--space-lg)',
        cursor: expandable ? 'pointer' : 'default',
        transition: 'all var(--transition-base)',
        boxShadow: 'var(--shadow-sm)',
      }}
      onClick={() => expandable && setIsExpanded(!isExpanded)}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-md)',
          marginBottom: isExpanded ? 'var(--space-md)' : 0,
        }}
      >
        {icon && (
          <div
            style={{
              fontSize: '1.5rem',
              color: colorMap[colorScheme].bg,
            }}
          >
            {icon}
          </div>
        )}
        <h3
          style={{
            color: colorMap[colorScheme].bg,
            flex: 1,
            margin: 0,
          }}
        >
          {title}
        </h3>
        {expandable && (
          <div
            style={{
              transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform var(--transition-fast)',
              fontSize: '1.25rem',
              color: colorMap[colorScheme].bg,
            }}
          >
            ▼
          </div>
        )}
      </div>
      {isExpanded && (
        <div
          style={{
            color: 'var(--color-text-secondary)',
            fontSize: 'var(--text-sm)',
            lineHeight: 1.8,
          }}
        >
          {content}
        </div>
      )}
    </div>
  );
};

// Gradient Button
export const GradientButton = ({
  children,
  gradient = 'cool',
  onClick,
  disabled = false,
  size = 'md',
}: {
  children: React.ReactNode;
  gradient?: 'warm' | 'cool' | 'peach-coral' | 'lime-teal' | 'purple-magenta';
  onClick?: () => void;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
}) => {
  const gradientMap = {
    warm: 'var(--gradient-warm)',
    cool: 'var(--gradient-cool)',
    'peach-coral': 'var(--gradient-peach-coral)',
    'lime-teal': 'var(--gradient-lime-teal)',
    'purple-magenta': 'var(--gradient-purple-magenta)',
  };

  const sizeMap = {
    sm: { padding: 'var(--space-sm) var(--space-md)', fontSize: 'var(--text-sm)' },
    md: { padding: 'var(--space-md) var(--space-lg)', fontSize: 'var(--text-base)' },
    lg: { padding: 'var(--space-lg) var(--space-xl)', fontSize: 'var(--text-lg)' },
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: gradientMap[gradient],
        color: 'white',
        border: 'none',
        borderRadius: 'var(--radius-lg)',
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'all var(--transition-base)',
        transform: 'scale(1)',
        boxShadow: 'var(--shadow-md)',
        ...sizeMap[size],
      }}
      onMouseDown={(e) => {
        if (!disabled) {
          (e.target as HTMLElement).style.transform = 'scale(0.97)';
        }
      }}
      onMouseUp={(e) => {
        (e.target as HTMLElement).style.transform = 'scale(1)';
      }}
      onMouseLeave={(e) => {
        (e.target as HTMLElement).style.transform = 'scale(1)';
      }}
    >
      {children}
    </button>
  );
};

// Stat Badge
export const StatBadge = ({
  label,
  value,
  colorScheme = 'cyan',
}: {
  label: string;
  value: string | number;
  colorScheme?: 'coral' | 'orange' | 'lime' | 'cyan' | 'purple' | 'magenta';
}) => {
  const colorMap = {
    coral: { bg: 'var(--color-primary-coral)', light: 'rgba(255, 127, 107, 0.1)' },
    orange: { bg: 'var(--color-primary-peach)', light: 'rgba(255, 154, 118, 0.1)' },
    lime: { bg: 'var(--color-primary-lime)', light: 'rgba(107, 203, 119, 0.1)' },
    cyan: { bg: 'var(--color-primary-teal)', light: 'rgba(45, 212, 191, 0.1)' },
    purple: { bg: 'var(--color-primary-purple)', light: 'rgba(184, 159, 217, 0.1)' },
    magenta: { bg: 'var(--color-primary-rose)', light: 'rgba(255, 107, 157, 0.1)' },
  };

  return (
    <div
      style={{
        backgroundColor: colorMap[colorScheme].light,
        border: `2px solid ${colorMap[colorScheme].bg}`,
        borderRadius: 'var(--radius-full)',
        padding: 'var(--space-sm) var(--space-md)',
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--space-xs)',
        minWidth: '100px',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      <div
        style={{
          fontSize: 'var(--text-xs)',
          color: 'var(--color-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 'var(--text-2xl)',
          fontWeight: 700,
          color: colorMap[colorScheme].bg,
        }}
      >
        {value}
      </div>
    </div>
  );
};

// Loading Spinner
export const LoadingSpinner = ({
  colorScheme = 'cyan',
  size = 'md',
}: {
  colorScheme?: 'coral' | 'orange' | 'lime' | 'cyan' | 'purple' | 'magenta';
  size?: 'sm' | 'md' | 'lg';
}) => {
  const colorMap = {
    coral: 'var(--color-primary-coral)',
    orange: 'var(--color-primary-peach)',
    lime: 'var(--color-primary-lime)',
    cyan: 'var(--color-primary-teal)',
    purple: 'var(--color-primary-purple)',
    magenta: 'var(--color-primary-rose)',
  };

  const sizeMap = {
    sm: '24px',
    md: '40px',
    lg: '60px',
  };

  return (
    <div
      style={{
        width: sizeMap[size],
        height: sizeMap[size],
        border: `4px solid ${colorMap[colorScheme]}30`,
        borderTop: `4px solid ${colorMap[colorScheme]}`,
        borderRadius: '50%',
        animation: 'spin 1s linear infinite',
        boxShadow: `0 0 10px ${colorMap[colorScheme]}40`,
      }}
    />
  );
};

// Add spin animation
const style = document.createElement('style');
style.textContent = `
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
`;
document.head.appendChild(style);

// Section Header
export const SectionHeader = ({
  title,
  subtitle,
  colorScheme = 'cyan',
}: {
  title: string;
  subtitle?: string;
  colorScheme?: 'coral' | 'orange' | 'lime' | 'cyan' | 'purple' | 'magenta';
}) => {
  const colorMap = {
    coral: 'var(--color-primary-coral)',
    orange: 'var(--color-primary-peach)',
    lime: 'var(--color-primary-lime)',
    cyan: 'var(--color-primary-teal)',
    purple: 'var(--color-primary-purple)',
    magenta: 'var(--color-primary-rose)',
  };

  return (
    <div style={{ marginBottom: 'var(--space-2xl)' }}>
      <h2
        style={{
          fontSize: 'var(--text-3xl)',
          fontWeight: 700,
          color: 'var(--color-text-primary)',
          marginBottom: 'var(--space-sm)',
          backgroundImage: `linear-gradient(90deg, ${colorMap[colorScheme]}, var(--color-text-secondary))`,
          backgroundClip: 'text',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
        }}
      >
        {title}
      </h2>
      {subtitle && (
        <p style={{ color: 'var(--color-text-muted)', marginBottom: 0 }}>
          {subtitle}
        </p>
      )}
    </div>
  );
};
