import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    void Promise.resolve()
      .then(() => window.desktop?.setOverlay(true))
      .catch((error) =>
        console.error('Could not hide embedded page after renderer failure', error),
      );
  }
  render() {
    if (this.state.failed)
      return (
        <main className="startup-error">
          <h1>Workbench</h1>
          <p>界面遇到问题 / Something went wrong.</p>
          <button onClick={() => location.reload()}>重新载入 / Reload</button>
        </main>
      );
    return this.props.children;
  }
}
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
