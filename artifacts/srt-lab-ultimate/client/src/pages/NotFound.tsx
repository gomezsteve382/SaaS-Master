import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";
import { AlertTriangle, ArrowLeft } from "lucide-react";

export default function NotFound() {
  const [, navigate] = useLocation();

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
      <div className="text-center space-y-4">
        <AlertTriangle className="w-12 h-12 text-primary mx-auto" />
        <h1 className="text-2xl font-bold">404 — Not Found</h1>
        <p className="text-muted-foreground">The page you're looking for doesn't exist.</p>
        <Button onClick={() => navigate("/")} variant="default">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Dashboard
        </Button>
      </div>
    </div>
  );
}
