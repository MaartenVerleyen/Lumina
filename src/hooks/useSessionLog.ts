import { useState, useCallback } from "react";

export interface SessionLogEntry {
  id: string;
  timestamp: string;
  category: "LIBRARY" | "TRIAGE" | "FACE" | "AI" | "DISK";
  message: string;
  details?: string;
}

export function useSessionLog() {
  const [logs, setLogs] = useState<SessionLogEntry[]>([]);

  const addLog = useCallback(
    (category: SessionLogEntry["category"], message: string, details?: string) => {
      const entry: SessionLogEntry = {
        id: Math.random().toString(36).substring(2, 9),
        timestamp: new Date().toLocaleTimeString(),
        category,
        message,
        details,
      };
      setLogs((prev) => [entry, ...prev.slice(0, 499)]); // Retain last 500 actions
    },
    []
  );

  const clearLogs = useCallback(() => setLogs([]), []);

  return { logs, addLog, clearLogs };
}