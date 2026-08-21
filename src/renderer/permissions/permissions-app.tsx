import * as React from 'react';
import { PermissionsScreen } from './permissions-screen.tsx';
import type { UiLang } from './rule-labels.ts';
import type { ProjectSummary, ProjectsList } from '../../shared/ipc.ts';

/**
 * The permissions island, wired: it reads the project list once and holds which project is
 * selected, then hands both to the presentational screen.
 *
 * The project list is read here rather than in the screen because selecting a project is
 * this island's only piece of state, and a screen that owned it could not be rendered with a
 * chosen project by the screenshot harness.
 */
export function PermissionsApp({ lang, onNavigate }: {
    lang: UiLang;
    onNavigate: (view: string) => void;
}): React.JSX.Element {
    const [projects, setProjects] = React.useState<readonly ProjectSummary[]>([]);
    const [projectId, setProjectId] = React.useState<string | null>(null);

    React.useEffect(() => {
        void (async () => {
            try {
                const reply = await window.stafford.projects.list() as ProjectsList;
                setProjects(reply.projects);
                // Open on the first project rather than on an empty picker, so the screen
                // shows something real the moment it is opened.
                setProjectId((current) => current ?? reply.projects[0]?.id ?? null);
            } catch {
                // A failed list leaves the empty state, which already says what to do.
                setProjects([]);
            }
        })();
    }, []);

    return (
        <PermissionsScreen
            lang={lang}
            projects={projects}
            projectId={projectId}
            onSelectProject={setProjectId}
            onNavigate={onNavigate}
        />
    );
}
