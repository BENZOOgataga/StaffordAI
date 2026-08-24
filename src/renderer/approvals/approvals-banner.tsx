import * as React from 'react';
import { ShieldAlert, Terminal, FileText } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useApprovals } from './use-approvals.ts';
import type { PendingApproval, RosterCard } from '../../shared/ipc.ts';

/**
 * The approvals surface (phase 2): the permission asks waiting on the person, so one is
 * never missed even when it is on another colleague's screen. Each shows which colleague,
 * the action, and the path or command, with Approve and Deny and an optional note that
 * becomes the deny reason the colleague reads. Approving resumes the paused turn; denying
 * stops it. The colleague also reads as waiting for you on the roster while it is paused.
 */

function summarize(approval: PendingApproval): { icon: React.ReactNode; text: string } {
    if (approval.command !== null) {
        const c = approval.command.replace(/\s+/g, ' ').trim();
        return { icon: <Terminal className="size-4" />, text: 'run ' + (c.length > 80 ? c.slice(0, 80) + '...' : c) };
    }
    if (approval.path !== null) {
        return { icon: <FileText className="size-4" />, text: approval.action + ' ' + approval.path };
    }
    return { icon: <ShieldAlert className="size-4" />, text: 'a ' + approval.action + ' action' };
}

function ApprovalRow({ approval, name }: { approval: PendingApproval; name: string }): React.JSX.Element {
    const [note, setNote] = React.useState('');
    const { icon, text } = summarize(approval);
    const answer = (approve: boolean): void => {
        void window.stafford.approvals.answer(approval.id, approve, note.trim().length > 0 ? note.trim() : null);
    };
    return (
        <div className="border-border flex flex-col gap-2 rounded-md border p-3">
            <div className="flex min-w-0 items-start gap-2">
                <span className="text-status-waiting mt-0.5">{icon}</span>
                <span className="min-w-0 flex-1 text-sm break-words">
                    <span className="font-medium">{name}</span> wants to {text}
                </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Reason (optional, shown on deny)"
                    aria-label={'Reason for ' + name + ' approval'}
                    className="h-8 min-w-0 flex-1"
                />
                <Button size="sm" onClick={() => answer(true)}>Approve</Button>
                <Button size="sm" variant="secondary" onClick={() => answer(false)}>Deny</Button>
            </div>
        </div>
    );
}

export function ApprovalsBanner({ cards }: { cards: readonly RosterCard[] }): React.JSX.Element | null {
    const pending = useApprovals();
    if (pending.length === 0) return null;
    const nameOf = (hireId: string): string => cards.find((c) => c.id === hireId)?.name ?? hireId;
    return (
        <Card className="border-status-waiting/40 gap-3 p-4">
            {/* role="alert" so a screen reader announces the banner when it appears, not only
                when a sighted user sees it. It carries the summary line alone, not the whole
                interactive form below, so the announcement is the event, not every control. */}
            <div className="flex items-center gap-2" role="alert">
                <ShieldAlert className="text-status-waiting size-4" />
                <span className="text-sm font-medium">
                    {pending.length === 1 ? 'A colleague needs your approval' : pending.length + ' colleagues need your approval'}
                </span>
            </div>
            <div className="flex flex-col gap-2">
                {pending.map((approval) => (
                    <ApprovalRow key={approval.id} approval={approval} name={nameOf(approval.hireId)} />
                ))}
            </div>
        </Card>
    );
}
