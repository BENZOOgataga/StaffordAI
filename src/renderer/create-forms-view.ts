/**
 * The pure decisions behind the create forms, kept out of the DOM so they are
 * tested without a browser: the advisory path hint, what makes a form
 * submittable, whether hiring is possible yet, which project is preselected, and
 * the role options and localized copy.
 *
 * The path hint is advisory only. Main's `project:create` is the authority on
 * whether a repo path is a real directory, and it still runs and still rejects a
 * bad path regardless of what this hint says. The renderer has no filesystem, so
 * this can only guess from the shape of the string, never confirm the directory
 * exists. Nobody downstream should treat this as the check.
 */

import { AGENT_DEFINITIONS, definitionFor } from '../domain/definitions.ts';

export type Lang = 'en' | 'fr';

export interface ProjectFormState {
    readonly name: string;
    readonly repoPath: string;
}

/** A guess from the string shape, never a confirmation the directory exists. */
export type PathHint = 'empty' | 'looks-relative' | 'looks-absolute';

export function pathHint(path: string): PathHint {
    const p = path.trim();
    if (p.length === 0) return 'empty';
    // A repo path a user hands over is absolute. This guides before submit; it is
    // not the existence check, which only main can do.
    const looksAbsolute = /^([A-Za-z]:[\\/]|\\\\|\/)/.test(p);
    return looksAbsolute ? 'looks-absolute' : 'looks-relative';
}

/** The project form can be submitted once it has a name and a repo path. */
export function projectSubmittable(state: ProjectFormState): boolean {
    return state.name.trim().length > 0 && state.repoPath.trim().length > 0;
}

/** A hire needs a project to belong to, so hiring is gated until one exists. */
export function canHire(projectCount: number): boolean {
    return projectCount > 0;
}

/** With exactly one project, preselect it; otherwise no preselection. */
export function preselectedProjectId(projects: readonly { id: string }[]): string | null {
    return projects.length === 1 ? projects[0]!.id : null;
}

/** The six roles a colleague can be hired as, for the form's role picker. */
export function roleOptions(): readonly { type: string; title: string }[] {
    return AGENT_DEFINITIONS.map((d) => ({ type: d.type, title: d.title }));
}

/** The display title for a role, or the type itself if it is somehow unknown. */
export function titleForType(type: string): string {
    return definitionFor(type)?.title ?? type;
}

/**
 * Localized copy for the empty state and the forms. French is present from the
 * start, and it is the longer text the labels have to flex for without
 * overflowing, so it is what the flex is proven against.
 */
export interface FormCopy {
    readonly emptyLead: string;
    readonly emptyBody: string;
    readonly addProject: string;
    readonly hire: string;
    readonly projectTitle: string;
    readonly hireTitle: string;
    readonly nameLabel: string;
    readonly repoLabel: string;
    readonly roleLabel: string;
    readonly projectLabel: string;
    readonly hintAbsolute: string;
    readonly hintRelative: string;
    readonly hintEmpty: string;
    readonly create: string;
    readonly cancel: string;
    readonly hireNeedsProject: string;
    /** Tells the person the name is assigned, since the hire form no longer asks for one. */
    readonly hireNameNote: string;
}

const EN: FormCopy = {
    emptyLead: 'Manage Claude Code as a team',
    emptyBody: 'Add a project, then hire a colleague to work in it. Start by adding a project.',
    addProject: 'Add a project',
    hire: 'Hire a colleague',
    projectTitle: 'Add a project',
    hireTitle: 'Hire a colleague',
    nameLabel: 'Name',
    repoLabel: 'Repository folder',
    roleLabel: 'Role',
    projectLabel: 'Project',
    hintAbsolute: 'Looks like a folder path. I check it exists when you add it.',
    hintRelative: 'Enter the full path to an existing folder on this machine.',
    hintEmpty: 'The full path to the project folder on this machine.',
    create: 'Add project',
    cancel: 'Cancel',
    hireNeedsProject: 'Add a project first, so your colleague has somewhere to work.',
    hireNameNote: 'Your colleague gets a name automatically. You pick the role and the project.'
};

const FR: FormCopy = {
    emptyLead: 'Gérez Claude Code comme une équipe',
    emptyBody: 'Ajoutez un projet, puis engagez un collègue pour y travailler. Commencez par ajouter un projet.',
    addProject: 'Ajouter un projet',
    hire: 'Engager un collègue',
    projectTitle: 'Ajouter un projet',
    hireTitle: 'Engager un collègue',
    nameLabel: 'Nom',
    repoLabel: 'Dossier du dépôt',
    roleLabel: 'Rôle',
    projectLabel: 'Projet',
    hintAbsolute: 'Cela ressemble à un chemin de dossier. Je vérifie son existence à l\'ajout.',
    hintRelative: 'Saisissez le chemin complet vers un dossier existant sur cette machine.',
    hintEmpty: 'Le chemin complet vers le dossier du projet sur cette machine.',
    create: 'Ajouter le projet',
    cancel: 'Annuler',
    hireNeedsProject: 'Ajoutez d\'abord un projet, pour que votre collègue ait un endroit où travailler.',
    hireNameNote: 'Votre collègue reçoit un nom automatiquement. Vous choisissez le rôle et le projet.'
};

export function formCopy(lang: Lang): FormCopy {
    return lang === 'fr' ? FR : EN;
}

export function hintText(copy: FormCopy, hint: PathHint): string {
    if (hint === 'looks-absolute') return copy.hintAbsolute;
    if (hint === 'looks-relative') return copy.hintRelative;
    return copy.hintEmpty;
}
