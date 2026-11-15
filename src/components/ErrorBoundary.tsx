import { Component, type ErrorInfo, type ReactNode } from "react";

// A part of the window that fails to draw shows what happened and a way back, instead of an empty window
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Lumina: the window failed to draw", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-zinc-950 text-zinc-200 p-6">
        <div className="max-w-md text-center flex flex-col gap-3">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-sm text-zinc-400">
            Lumina couldn't show this screen. Your photos and changes are safe. Reloading the window usually helps.
          </p>
          <pre className="text-left text-[11px] text-zinc-500 bg-zinc-900 rounded-lg p-3 overflow-auto max-h-40 whitespace-pre-wrap">
            {String(this.state.error?.message ?? this.state.error)}
          </pre>
          <div className="flex justify-center gap-2">
            <button
              onClick={() => this.setState({ error: null })}
              className="px-3 py-1.5 rounded-lg border border-zinc-700 text-sm hover:bg-zinc-800"
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm text-white"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
