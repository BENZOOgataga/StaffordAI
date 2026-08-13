/**
 * The create forms: the first real user actions, "add a project" and "hire a
 * colleague", over the projects.create and hire.create bridge. Two sheets in the
 * same window, in the roster's register, built here and wired to the bridge.
 *
 * The path field carries a live advisory hint from create-forms-view, but the
 * authority is always main: projects.create validates the directory exists and
 * rejects a bad path, and this shows that rejection on the form without losing
 * what the user typed. The client hint never gates the submit or replaces main.
 */

import {
    formCopy, pathHint, hintText, projectSubmittable, canHire, preselectedProjectId,
    roleOptions, titleForType, type Lang, type FormCopy
} from './create-forms-view.ts';

const lang: Lang = typeof navigator !== 'undefined' && navigator.language.startsWith('fr') ? 'fr' : 'en';
const copy: FormCopy = formCopy(lang);

let onCreated: () => void = () => {};

const projectSheet = document.getElementById('project-sheet') as HTMLElement;
const hireSheet = document.getElementById('hire-sheet') as HTMLElement;

// Project form elements.
const projectName = document.getElementById('project-name') as HTMLInputElement;
const projectRepo = document.getElementById('project-repo') as HTMLInputElement;
const projectHint = document.getElementById('project-hint') as HTMLElement;
const projectError = document.getElementById('project-error') as HTMLElement;
const projectCreate = document.getElementById('project-create') as HTMLButtonElement;
const projectCancel = document.getElementById('project-cancel') as HTMLButtonElement;

// Hire form elements.
const hireName = document.getElementById('hire-name') as HTMLInputElement;
const hireRole = document.getElementById('hire-role') as HTMLSelectElement;
const hireProject = document.getElementById('hire-project') as HTMLSelectElement;
const hireError = document.getElementById('hire-error') as HTMLElement;
const hireSubmit = document.getElementById('hire-submit') as HTMLButtonElement;
const hireCancel = document.getElementById('hire-cancel') as HTMLButtonElement;

function showError(el: HTMLElement, message: string): void {
    el.textContent = message;
    el.hidden = false;
}
function clearError(el: HTMLElement): void {
    el.textContent = '';
    el.hidden = true;
}

function refreshProjectHint(): void {
    projectHint.textContent = hintText(copy, pathHint(projectRepo.value));
}

function openSheet(sheet: HTMLElement, firstField: HTMLElement): void {
    sheet.hidden = false;
    firstField.focus();
}
function closeSheet(sheet: HTMLElement): void {
    sheet.hidden = true;
}

export function openProjectForm(): void {
    clearError(projectError);
    projectName.value = '';
    projectRepo.value = '';
    refreshProjectHint();
    openSheet(projectSheet, projectName);
}

async function submitProject(): Promise<void> {
    clearError(projectError);
    // The client hint never gates this; an empty name or path is the only local
    // block, and even a path that looks fine is still validated by main.
    if (!projectSubmittable({ name: projectName.value, repoPath: projectRepo.value })) {
        showError(projectError, copy.repoLabel + ': ' + copy.hintEmpty);
        return;
    }
    try {
        await window.stafford.projects.create(projectName.value.trim(), [projectRepo.value.trim()]);
        closeSheet(projectSheet);
        onCreated();
    } catch (err) {
        // Main is the authority. A bad path or empty name is rejected there; show
        // it here and keep what the user typed so they can fix the path.
        showError(projectError, messageOf(err));
    }
}

/** Fills the hire form's project picker; returns whether any project exists. */
async function loadProjectsIntoHire(): Promise<boolean> {
    const { projects } = await window.stafford.projects.list();
    hireProject.replaceChildren();
    for (const p of projects) {
        const option = document.createElement('option');
        option.value = p.id;
        option.textContent = p.name;
        hireProject.appendChild(option);
    }
    const preselect = preselectedProjectId(projects);
    if (preselect) hireProject.value = preselect;
    return canHire(projects.length);
}

export async function openHireForm(): Promise<void> {
    clearError(hireError);
    hireName.value = '';
    const hireable = await loadProjectsIntoHire();
    if (!hireable) {
        // No project to belong to. Guide to add-a-project-first rather than open a
        // dead-end form.
        openProjectForm();
        showError(projectError, copy.hireNeedsProject);
        return;
    }
    openSheet(hireSheet, hireName);
}

async function submitHire(): Promise<void> {
    clearError(hireError);
    const name = hireName.value.trim();
    const type = hireRole.value;
    const projectId = hireProject.value;
    if (name.length === 0 || projectId.length === 0) {
        showError(hireError, copy.nameLabel);
        return;
    }
    try {
        await window.stafford.hire.create(name, type, titleForType(type), projectId);
        closeSheet(hireSheet);
        onCreated();
    } catch (err) {
        showError(hireError, messageOf(err));
    }
}

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Enter submits, Escape cancels, the same conventions as the detail message box. */
function wireKeys(sheet: HTMLElement, submit: () => void): void {
    sheet.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); closeSheet(sheet); }
        else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); }
    });
}

export function initCreateForms(deps: { onCreated: () => void }): void {
    onCreated = deps.onCreated;

    // The role picker is the six definitions; the title follows the role.
    for (const role of roleOptions()) {
        const option = document.createElement('option');
        option.value = role.type;
        option.textContent = role.title;
        hireRole.appendChild(option);
    }

    projectRepo.addEventListener('input', refreshProjectHint);
    projectCreate.addEventListener('click', () => void submitProject());
    projectCancel.addEventListener('click', () => closeSheet(projectSheet));
    hireSubmit.addEventListener('click', () => void submitHire());
    hireCancel.addEventListener('click', () => closeSheet(hireSheet));
    wireKeys(projectSheet, () => void submitProject());
    wireKeys(hireSheet, () => void submitHire());

    // Localize the static labels so the copy is one source, en or fr.
    localizeLabels();
}

function localizeLabels(): void {
    const set = (id: string, text: string): void => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };
    set('project-sheet-title', copy.projectTitle);
    set('project-name-label', copy.nameLabel);
    set('project-repo-label', copy.repoLabel);
    set('project-create', copy.create);
    set('project-cancel', copy.cancel);
    set('hire-sheet-title', copy.hireTitle);
    set('hire-name-label', copy.nameLabel);
    set('hire-role-label', copy.roleLabel);
    set('hire-project-label', copy.projectLabel);
    set('hire-submit', copy.hire);
    set('hire-cancel', copy.cancel);
    refreshProjectHint();
}
