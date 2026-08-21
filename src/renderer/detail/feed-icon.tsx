import * as React from 'react';
import {
    Bell, OctagonAlert, ShieldAlert, Hourglass, Circle,
    Pencil, FilePlus2, Terminal, FileText, Search, Send, Wrench
} from 'lucide-react';
import type { FeedIcon } from '../activity-view.ts';

/**
 * One small line icon per feed row type, from Lucide, imported individually so only the
 * icons used are bundled. It mirrors the icon keys the activity-view helpers produce, so
 * the React feed reads the same category cues the vanilla feed did.
 */
const GLYPHS: Record<FeedIcon, React.ComponentType<{ className?: string }>> = {
    waiting: Bell,
    crashed: OctagonAlert,
    needs_trust: ShieldAlert,
    rate_limited: Hourglass,
    event: Circle,
    edit: Pencil,
    wrote: FilePlus2,
    command: Terminal,
    read: FileText,
    search: Search,
    task: Send,
    tool: Wrench
};

export function FeedIconGlyph({ icon, className = '' }: { icon: FeedIcon; className?: string }): React.JSX.Element {
    const Glyph = GLYPHS[icon] ?? Wrench;
    return <Glyph className={className} />;
}
