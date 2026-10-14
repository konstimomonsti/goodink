// A link or video opened in its own tab: YouTube plays here with its transcript beside it; a web page
// shows as a clean reader view. Both can be sent to Study to make flashcards.
import { useEffect, useMemo, useState } from 'react';
import { AppWindow, ExternalLink, GraduationCap, Home, Search } from 'lucide-react';
import { activateTab, findSourcesFor, makeCardsFrom, useApp } from '../lib/store';
import { api } from '../lib/api';
import { domainOf } from '../lib/web';
import { WebPreview } from './WebPreview';
import { youtubeId, youtubeTranscript } from '../study/youtube';
import { Button, IconButton, Spinner } from '../ui/primitives';

export function LinkView({ id, active = true }: { id: string; active?: boolean }) {
  const link = useApp((s) => s.library.links?.find((x) => x.id === id));
  if (!link) return <div className="editor-msg">This link is no longer in your library.</div>;
  return (
    <div className="linkview">
      <header className="lv-head" role="toolbar" aria-label={link.title}>
        <IconButton label="Files" onClick={() => activateTab(null)}>
          <Home size={18} />
        </IconButton>
        <div className="lv-title">
          <strong className="ellipsis">{link.title}</strong>
          <span className="muted small ellipsis">{link.kind === 'youtube' ? `YouTube${link.author ? ` · ${link.author}` : ''}` : domainOf(link.url)}</span>
        </div>
        <Button onClick={() => makeCardsFrom(link.id)}>
          <GraduationCap size={16} /> Make flashcards
        </Button>
        {link.folderId && (
          <Button variant="ghost" onClick={() => findSourcesFor(link.id)} title="Find more sources about this into the same folder">
            <Search size={16} /> More sources
          </Button>
        )}
        {link.kind === 'link' && (
          <IconButton label="Open in a separate goodink window" onClick={() => void api.openWebWindow(link.url, link.title)}>
            <AppWindow size={16} />
          </IconButton>
        )}
        <IconButton label="Open in your browser" onClick={() => void api.openUrl(link.url)}>
          <ExternalLink size={16} />
        </IconButton>
      </header>
      {link.kind === 'youtube' ? <VideoView url={link.url} /> : <WebPreview url={link.url} visible={active} />}
    </div>
  );
}

export function VideoView({ url }: { url: string }) {
  const vid = youtubeId(url)!;
  const [start, setStart] = useState(0);
  const [tr, setTr] = useState<{ text: string; automatic: boolean } | null | 'loading'>('loading');
  useEffect(() => {
    void youtubeTranscript(vid).then(setTr, () => setTr(null));
  }, [vid]);
  const lines = useMemo(
    () =>
      typeof tr === 'object' && tr
        ? tr.text.split('\n').map((l) => {
            const m = /^\[(?:(\d+):)?(\d+):(\d\d)\] (.*)$/.exec(l.trim());
            return m ? { t: (+(m[1] ?? 0) * 3600) + +m[2] * 60 + +m[3], label: l.slice(1, l.indexOf(']')), text: m[4] } : { t: -1, label: '', text: l };
          })
        : [],
    [tr],
  );
  return (
    <div className="lv-video">
      <div className="lv-player">
        <iframe
          key={start}
          src={`https://www.youtube-nocookie.com/embed/${vid}?rel=0${start ? `&start=${start}&autoplay=1` : ''}`}
          title="YouTube video"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
        />
      </div>
      <aside className="lv-transcript" aria-label="Transcript">
        <h3>Transcript{typeof tr === 'object' && tr?.automatic ? ' (automatic captions)' : ''}</h3>
        {tr === 'loading' && <Spinner size={18} />}
        {tr === null && <p className="muted">YouTube offers no readable captions for this video. You can still make flashcards: Google Gemini watches the video itself.</p>}
        {lines.map((l, i) =>
          l.t >= 0 ? (
            <p key={i}>
              <button type="button" className="page-ref" onClick={() => setStart(l.t)} title="Play from here">
                {l.label}
              </button>{' '}
              {l.text}
            </p>
          ) : (
            l.text && <p key={i}>{l.text}</p>
          ),
        )}
      </aside>
    </div>
  );
}
