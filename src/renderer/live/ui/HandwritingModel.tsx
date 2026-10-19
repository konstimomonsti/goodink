// The free on-device math reader (Pix2Text MFR 1.5, MIT): shows whether it is installed and
// downloads it on request (120 MB, once, checksum-verified by the backend). Until then the built-in
// Windows recogniser reads alone, and in Smart the cloud model reads what it is unsure of.
import { useEffect, useState } from 'react';
import { Check, Download } from 'lucide-react';
import { api } from '../../lib/api';
import { recheckModel } from '../recog';
import { Button } from '../../ui/primitives';

type State = 'checking' | 'missing' | 'installing' | 'ready' | 'error';

export function HandwritingModel() {
  const [state, setState] = useState<State>('checking');
  const [bytes, setBytes] = useState(0);
  const [done, setDone] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    let on = true;
    api
      .hmerStatus()
      .then((s) => {
        const m = s.models.find((x) => x.id === s.defaultModel);
        if (!on) return;
        setBytes(m?.bytes ?? 0);
        setState(m?.installed ? 'ready' : 'missing');
      })
      .catch(() => on && setState('error'));
    return () => {
      on = false;
    };
  }, []);

  const install = async () => {
    setState('installing');
    setError('');
    const got = new Map<string, number>();
    try {
      await api.hmerInstall(undefined, (p) => {
        got.set(p.file, p.received);
        setDone([...got.values()].reduce((a, b) => a + b, 0));
      });
      await recheckModel();
      setState('ready');
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setState('missing');
    }
  };

  const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
  return (
    <div className="live-model" aria-live="polite">
      <div className="live-model-text">
        <span className="live-model-title">On-device math reader</span>
        <span className="live-model-line">
          {state === 'ready'
            ? 'Installed. Reads handwritten formulas on this device, offline.'
            : `Pix2Text MFR, free (MIT). Reads handwritten formulas far better than the built-in recogniser, offline.${bytes ? ` ${mb(bytes)}, once.` : ''}`}
        </span>
        {state === 'installing' && (
          <span className="live-model-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={bytes ? Math.round((done / bytes) * 100) : 0}>
            <span style={{ width: `${bytes ? Math.min(100, (done / bytes) * 100) : 5}%` }} />
          </span>
        )}
        {error && <span className="live-model-error">Download failed: {error}</span>}
      </div>
      {state === 'ready' ? (
        <Check size={16} className="live-model-ok" aria-label="Installed" />
      ) : state === 'missing' || state === 'installing' ? (
        <Button size="sm" variant="ghost" onClick={() => void install()} disabled={state === 'installing'}>
          <Download size={14} /> {state === 'installing' ? `${mb(done)} / ${mb(bytes)}` : 'Download'}
        </Button>
      ) : null}
    </div>
  );
}
