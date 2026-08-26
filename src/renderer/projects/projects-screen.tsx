import * as React from 'react';
import { FolderGit2, Folder, Pencil, Trash2, Plus, TriangleAlert, Link2 } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { type Lang } from '../channel-view.ts';
import type { ProjectsManageReply, ProjectManageView, ColleagueRef } from '../../shared/ipc.ts';

/**
 * The Projects management tab: every project with its folder and bound colleagues, editable and
 * deletable, plus the parked colleagues (bound to no project) with a rebind control. This is the one
 * place a project is more than a name picked once: its folder can be repointed (validated exactly as a
 * create is), it can be deleted (which parks its colleagues rather than deleting them), and a parked
 * colleague can be rebound to a project as a fresh session.
 *
 * Only this UI manages projects. A colleague has no preload and no channel, so it cannot reach any of
 * these writes, the same boundary the permissions surface keeps.
 */

interface Copy {
    title: string; add: string; create: string; cancel: string; name: string; folder: string; browse: string;
    save: string; edit: string; del: string; noProjects: string; addHint: string; colleagues: string;
    none: string; parked: string; parkedHint: string; rebind: string; rebindTo: string; invalidFolder: string;
    working: string; namePh: string; deleteConfirm: string;
}

const COPY: Record<Lang, Copy> = {
    en: {
        title: 'Projects', add: 'Add a project', create: 'Create', cancel: 'Cancel', name: 'Name', folder: 'Folder',
        browse: 'Browse', save: 'Save', edit: 'Edit', del: 'Delete', noProjects: 'No projects yet',
        addHint: 'Add a project to put a colleague to work on it.', colleagues: 'Colleagues', none: 'None yet',
        parked: 'Parked colleagues', parkedHint: 'Bound to no project. Rebind one to put it back to work.',
        rebind: 'Rebind', rebindTo: 'Rebind to', invalidFolder: 'Folder missing, repoint it',
        working: 'working', namePh: 'Project name', deleteConfirm: 'Delete this project?'
    },
    fr: {
        title: 'Projets', add: 'Ajouter un projet', create: 'Créer', cancel: 'Annuler', name: 'Nom', folder: 'Dossier',
        browse: 'Parcourir', save: 'Enregistrer', edit: 'Modifier', del: 'Supprimer', noProjects: 'Aucun projet',
        addHint: 'Ajoutez un projet pour y mettre un collègue au travail.', colleagues: 'Collègues', none: 'Aucun',
        parked: 'Collègues sans projet', parkedHint: 'Liés à aucun projet. Réaffectez-en un pour le remettre au travail.',
        rebind: 'Réaffecter', rebindTo: 'Réaffecter vers', invalidFolder: 'Dossier introuvable, corrigez-le',
        working: 'au travail', namePh: 'Nom du projet', deleteConfirm: 'Supprimer ce projet ?'
    }
};

const EMPTY: ProjectsManageReply = { projects: [], parked: [] };

/** Reads the whole tab and re-reads on any project or roster change, so a write anywhere refreshes it. */
function useProjectsManage(): { data: ProjectsManageReply; reload: () => void } {
    const [data, setData] = React.useState<ProjectsManageReply>(EMPTY);
    const reload = React.useCallback(() => {
        void window.stafford.projects.manageView().then(setData).catch(() => setData(EMPTY));
    }, []);
    React.useEffect(() => {
        reload();
        const offP = window.stafford.projects.onChanged(reload);
        const offR = window.stafford.roster.onChanged(reload);
        return () => { offP(); offR(); };
    }, [reload]);
    return { data, reload };
}

function StateChip({ c, copy }: { c: ColleagueRef; copy: Copy }): React.JSX.Element {
    const working = c.state !== 'idle' && !c.parked;
    return (
        <span className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
            c.parked ? 'border-status-waiting/40 bg-status-waiting/5 text-status-waiting'
                : working ? 'border-status-working/40 bg-status-working/5 text-status-working'
                    : 'border-border bg-muted/30 text-muted-foreground'
        )}>
            {c.name}{working ? ' · ' + copy.working : ''}
        </span>
    );
}

/** The inline name + folder editor, reused by editing a project and by creating one. */
function ProjectForm({ copy, initialName, initialFolder, onSubmit, onCancel, submitLabel, error, busy }: {
    copy: Copy; initialName: string; initialFolder: string;
    onSubmit: (name: string, folder: string) => void; onCancel: () => void; submitLabel: string;
    error: string | null; busy: boolean;
}): React.JSX.Element {
    const [name, setName] = React.useState(initialName);
    const [folder, setFolder] = React.useState(initialFolder);
    const browse = async (): Promise<void> => {
        const picked = await window.stafford.projects.pickFolder();
        if (picked) setFolder(picked);
    };
    const canSubmit = name.trim() !== '' && folder.trim() !== '' && !busy;
    return (
        <div className="border-border bg-background/40 flex flex-col gap-2 rounded-md border p-3">
            <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground text-xs">{copy.name}</span>
                <input
                    className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                    value={name} placeholder={copy.namePh} onChange={(e) => setName(e.target.value)}
                />
            </label>
            <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground text-xs">{copy.folder}</span>
                <div className="flex gap-2">
                    <input
                        readOnly value={folder} placeholder="…"
                        className="border-input bg-muted/40 text-muted-foreground h-9 min-w-0 flex-1 truncate rounded-md border px-2 font-mono text-xs"
                    />
                    <Button type="button" size="sm" variant="secondary" onClick={() => void browse()}>{copy.browse}</Button>
                </div>
            </label>
            {error ? <p className="text-status-error text-xs" role="alert">{error}</p> : null}
            <div className="flex gap-2">
                <Button type="button" size="sm" disabled={!canSubmit} onClick={() => onSubmit(name.trim(), folder.trim())}>
                    {submitLabel}
                </Button>
                <Button type="button" size="sm" variant="secondary" onClick={onCancel}>{copy.cancel}</Button>
            </div>
        </div>
    );
}

function ProjectCard({ project, copy, onChanged }: {
    project: ProjectManageView; copy: Copy; onChanged: () => void;
}): React.JSX.Element {
    const [editing, setEditing] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const folder = project.repos[0]?.path ?? '';

    const save = async (name: string, newFolder: string): Promise<void> => {
        setBusy(true); setError(null);
        try {
            await window.stafford.projects.update(project.id, name, [newFolder]);
            setEditing(false);
            onChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    const remove = async (): Promise<void> => {
        setError(null);
        const reply = await window.stafford.projects.remove(project.id);
        if (!reply.ok) { setError(reply.warning); return; }
        onChanged();
    };

    return (
        <div className="border-border bg-card flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex min-w-0 items-start gap-2">
                <Folder className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{project.name}</span>
                        {!project.folderValid ? (
                            <span className="text-status-error inline-flex items-center gap-1 text-xs">
                                <TriangleAlert className="size-3.5" aria-hidden="true" />{copy.invalidFolder}
                            </span>
                        ) : null}
                    </div>
                    <div className="text-muted-foreground truncate font-mono text-xs">{folder}</div>
                </div>
                {!editing ? (
                    <div className="flex shrink-0 gap-1">
                        <Button type="button" size="sm" variant="ghost" onClick={() => { setEditing(true); setError(null); }}
                            aria-label={copy.edit}>
                            <Pencil className="size-3.5" aria-hidden="true" />
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => void remove()} aria-label={copy.del}>
                            <Trash2 className="text-status-error size-3.5" aria-hidden="true" />
                        </Button>
                    </div>
                ) : null}
            </div>

            {editing ? (
                <ProjectForm
                    copy={copy} initialName={project.name} initialFolder={folder}
                    onSubmit={(n, f) => void save(n, f)} onCancel={() => setEditing(false)}
                    submitLabel={copy.save} error={error} busy={busy}
                />
            ) : (
                <>
                    {error ? <p className="text-status-error text-xs" role="alert">{error}</p> : null}
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-muted-foreground text-xs">{copy.colleagues}:</span>
                        {project.colleagues.length === 0
                            ? <span className="text-muted-foreground text-xs italic">{copy.none}</span>
                            : project.colleagues.map((c) => <StateChip key={c.id} c={c} copy={copy} />)}
                    </div>
                </>
            )}
        </div>
    );
}

function ParkedRow({ colleague, projects, copy, onChanged }: {
    colleague: ColleagueRef; projects: readonly ProjectManageView[]; copy: Copy; onChanged: () => void;
}): React.JSX.Element {
    const [target, setTarget] = React.useState<string>(projects[0]?.id ?? '');
    const [busy, setBusy] = React.useState(false);
    const rebind = async (): Promise<void> => {
        if (!target) return;
        setBusy(true);
        try { await window.stafford.projects.rebind(colleague.id, target); onChanged(); }
        finally { setBusy(false); }
    };
    return (
        <div className="border-border bg-card flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
            <span className="text-status-waiting inline-flex items-center gap-1 text-sm font-medium">
                <Link2 className="size-3.5" aria-hidden="true" />{colleague.name}
            </span>
            <span className="text-muted-foreground text-xs">{colleague.title}</span>
            <div className="ml-auto flex items-center gap-2">
                <span className="text-muted-foreground text-xs">{copy.rebindTo}</span>
                <select
                    className="border-input bg-background h-8 min-w-[9rem] rounded-md border px-2 text-sm"
                    value={target} onChange={(e) => setTarget(e.target.value)}
                >
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <Button type="button" size="sm" disabled={!target || busy} onClick={() => void rebind()}>{copy.rebind}</Button>
            </div>
        </div>
    );
}

export function ProjectsScreen({ lang, onNavigate }: {
    lang: Lang; onNavigate: (view: string) => void;
}): React.JSX.Element {
    const copy = COPY[lang];
    const { data, reload } = useProjectsManage();
    const [creating, setCreating] = React.useState(false);
    const [createError, setCreateError] = React.useState<string | null>(null);
    const [createBusy, setCreateBusy] = React.useState(false);

    const create = async (name: string, folder: string): Promise<void> => {
        setCreateBusy(true); setCreateError(null);
        try {
            await window.stafford.projects.create(name, [folder]);
            setCreating(false);
            reload();
        } catch (e) {
            setCreateError(e instanceof Error ? e.message : String(e));
        } finally {
            setCreateBusy(false);
        }
    };

    return (
        <AppShell current="projects" onNavigate={onNavigate}>
            <section
                data-slot="content-panel"
                aria-label={copy.title}
                className="bg-card text-card-foreground flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border"
            >
                <div className="border-border flex items-center gap-3 border-b px-5 py-3">
                    <span className="text-muted-foreground [&_svg]:size-4"><FolderGit2 aria-hidden="true" /></span>
                    <span className="font-medium">{copy.title}</span>
                    <Button type="button" size="sm" className="ml-auto" data-projects-add
                        onClick={() => { setCreating((v) => !v); setCreateError(null); }}>
                        <Plus className="size-3.5" aria-hidden="true" />{copy.add}
                    </Button>
                </div>

                <div className="min-h-0 flex-1 overflow-auto p-5">
                    <div className="flex max-w-4xl flex-col gap-6">
                        {creating ? (
                            <ProjectForm
                                copy={copy} initialName="" initialFolder=""
                                onSubmit={(n, f) => void create(n, f)} onCancel={() => setCreating(false)}
                                submitLabel={copy.create} error={createError} busy={createBusy}
                            />
                        ) : null}

                        {data.projects.length === 0 && !creating ? (
                            <div className="flex flex-col items-center justify-center gap-2 p-10 text-center">
                                <p className="text-lg font-medium">{copy.noProjects}</p>
                                <p className="text-muted-foreground text-sm">{copy.addHint}</p>
                            </div>
                        ) : (
                            <div className="flex flex-col gap-3" data-projects-list>
                                {data.projects.map((p) => <ProjectCard key={p.id} project={p} copy={copy} onChanged={reload} />)}
                            </div>
                        )}

                        {data.parked.length > 0 ? (
                            <div className="flex flex-col gap-2" data-parked-section>
                                <div className="flex flex-col gap-0.5">
                                    <span className="text-status-waiting text-sm font-medium">{copy.parked}</span>
                                    <span className="text-muted-foreground text-xs">{copy.parkedHint}</span>
                                </div>
                                {data.parked.map((c) => (
                                    <ParkedRow key={c.id} colleague={c} projects={data.projects} copy={copy} onChanged={reload} />
                                ))}
                            </div>
                        ) : null}
                    </div>
                </div>
            </section>
        </AppShell>
    );
}
