import { useState, useEffect } from "react";
import { ThumbsUp, ThumbsDown } from "lucide-react";
import { Button } from "@/components/ui/button";

// ─── Types ──────────────────────────────────────────────────────────────────

interface RatingState {
  [key: string]: "up" | "down" | null;
}

interface FindingRatingProps {
  analysisId: string;
  agentId: string;
  findingIndex: number;
  findingCategory: string;
}

// ─── Single Finding Rating Buttons ──────────────────────────────────────────

export function FindingRatingButtons({
  analysisId,
  agentId,
  findingIndex,
  findingCategory,
}: FindingRatingProps) {
  const [rating, setRating] = useState<"up" | "down" | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleRate = async (newRating: "up" | "down") => {
    if (submitting) return;
    setSubmitting(true);

    try {
      const res = await fetch("/api/ratings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          analysisId,
          agentId,
          findingIndex,
          findingCategory,
          rating: newRating,
        }),
      });

      if (res.ok) {
        setRating(newRating);
      }
    } catch {}
    setSubmitting(false);
  };

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        className={`h-6 w-6 p-0 ${
          rating === "up"
            ? "text-green-400 bg-green-500/20"
            : "text-muted-foreground hover:text-green-400 hover:bg-green-500/10"
        }`}
        onClick={() => handleRate("up")}
        disabled={submitting}
      >
        <ThumbsUp className="w-3 h-3" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={`h-6 w-6 p-0 ${
          rating === "down"
            ? "text-red-400 bg-red-500/20"
            : "text-muted-foreground hover:text-red-400 hover:bg-red-500/10"
        }`}
        onClick={() => handleRate("down")}
        disabled={submitting}
      >
        <ThumbsDown className="w-3 h-3" />
      </Button>
    </div>
  );
}

// ─── Ratings Context Provider ───────────────────────────────────────────────
// Loads all existing ratings for an analysis and provides them to children

export function useAnalysisRatings(analysisId: string) {
  const [ratings, setRatings] = useState<RatingState>({});

  useEffect(() => {
    if (!analysisId) return;
    fetch(`/api/ratings/${analysisId}`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          const map: RatingState = {};
          for (const r of data) {
            map[`${r.agentId}-${r.findingIndex}`] = r.rating;
          }
          setRatings(map);
        }
      })
      .catch(() => {});
  }, [analysisId]);

  return ratings;
}
