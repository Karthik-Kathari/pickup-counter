import { useEffect, useState } from 'react';

type HealthState = 'checking' | 'up' | 'down';

/**
 * Phase 1 starter screen. Phase 7 replaces this with the catalog, cart,
 * countdown and polling UI. For now it only proves the web app builds and
 * can reach the API through the dev-server proxy.
 */
export default function App(): React.ReactElement {
  const [health, setHealth] = useState<HealthState>('checking');

  useEffect(() => {
    const controller = new AbortController();

    fetch('/health', { signal: controller.signal })
      .then((response) => setHealth(response.ok ? 'up' : 'down'))
      .catch(() => setHealth('down'));

    return () => controller.abort();
  }, []);

  const healthLabel: Record<HealthState, string> = {
    checking: 'checking API…',
    up: 'API: healthy',
    down: 'API: unreachable',
  };

  return (
    <main className="container">
      <h1>Pickup Counter</h1>
      <p className="tagline">Self-service snack pickup — Phase 1 foundation.</p>
      <p className={`health health--${health}`}>{healthLabel[health]}</p>
      <p className="muted">
        The catalog, cart, payment countdown and pickup flow arrive in Phase 7. Orders, payments and
        pickup APIs are built in Phases 2–5.
      </p>
    </main>
  );
}
