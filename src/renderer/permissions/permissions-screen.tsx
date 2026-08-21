import * as React from 'react';
import { ShieldCheck } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { RulesPanel } from './rules-panel.tsx';
import { useProjectRules } from './use-permissions.ts';
import type { UiLang } from './rule-labels.ts';
import type { ProjectSummary } from '../../shared/ipc.ts';

/**
 * The project baseline screen: the rules that apply to every colleague on a project.
 *
 * Baselines live here rather than in a colleague's detail pane because they belong to the
 * project, not to a person. A colleague's own exceptions live on that colleague, which is the
 * split the nav and the detail tab make visible: each rule sits where the thing it governs
 * sits.
 *
 * Presentational apart from the project list and the rules hook. It renders inside the shared
 * AppShell like every other screen, so the rail has one definition.
 */
export function PermissionsScreen({ lang, projects, projectId, onSelectProject, onNavigate }: {
    lang: UiLang;
    projects: readonly ProjectSummary[];
    projectId: string | null;
    onSelectProject: (id: string) => void;
    onNavigate: (view: string) => void;
}): React.JSX.Element {
    const { baseline, loaded, error } = useProjectRules(projectId);

    return (
        <AppShell current="permissions" onNavigate={onNavigate}>
            <section
                data-slot="content-panel"
                aria-label={lang === 'fr' ? 'Permissions' : 'Permissions'}
                className="bg-card text-card-foreground flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border"
            >
                <div className="border-border flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-5 py-3">
                    <span className="text-muted-foreground [&_svg]:size-4"><ShieldCheck aria-hidden="true" /></span>
                    <span className="font-medium">{lang === 'fr' ? 'Permissions' : 'Permissions'}</span>

                    <label className="ml-auto flex items-center gap-2 text-sm">
                        <span className="text-muted-foreground">{lang === 'fr' ? 'Projet' : 'Project'}</span>
                        <select
                            className="border-input bg-background h-9 min-w-[10rem] rounded-md border px-2 text-sm"
                            value={projectId ?? ''}
                            onChange={(e) => onSelectProject(e.target.value)}
                        >
                            {projects.length === 0
                                ? <option value="">{lang === 'fr' ? 'Aucun projet' : 'No projects'}</option>
                                : projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                    </label>
                </div>

                <div className="min-h-0 flex-1 overflow-auto p-5">
                    {projects.length === 0 ? (
                        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-10 text-center">
                            <p className="text-lg font-medium">{lang === 'fr' ? 'Aucun projet' : 'No projects yet'}</p>
                            <p className="text-muted-foreground text-sm">
                                {lang === 'fr'
                                    ? 'Ajoutez un projet pour définir ses permissions.'
                                    : 'Add a project to set its permissions.'}
                            </p>
                        </div>
                    ) : (
                        <RulesPanel
                            lang={lang}
                            title={lang === 'fr' ? 'Règles de base du projet' : 'Project baseline rules'}
                            hint={lang === 'fr'
                                ? 'Ces règles s’appliquent à tous les collègues de ce projet. Les exceptions par collègue se règlent sur le collègue.'
                                : 'These apply to every colleague on this project. Per-colleague exceptions are set on the colleague.'}
                            rules={baseline}
                            projectId={projectId}
                            hireId={null}
                            loaded={loaded}
                            error={error}
                        />
                    )}
                </div>
            </section>
        </AppShell>
    );
}
