import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function HexBytes({ bytes, className }: { bytes: string, className?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(bytes);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`group flex items-center gap-2 font-mono text-xs ${className}`}>
      <span className="text-foreground">{bytes}</span>
      <button 
        onClick={copy} 
        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-primary"
        title="Copy hex"
      >
        {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
      </button>
    </div>
  );
}
