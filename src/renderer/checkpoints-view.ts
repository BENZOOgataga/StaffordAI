/**
 * The localized copy for the saved-work notice, kept pure so it is tested without a
 * browser. The notice tells the person, quietly on launch, that a colleague's work
 * was saved on drain and the branch it is on, read from the drain report. It carries
 * no accent: this is information, not a waiting state.
 */

export type Lang = 'en' | 'fr';

/** The panel heading, singular or plural for how many colleagues were saved. */
export function savedWorkHeader(count: number, lang: Lang): string {
    if (lang === 'fr') return count === 1 ? 'Travail sauvegardé' : 'Travaux sauvegardés';
    return 'Saved work';
}

/** The text before the branch on one colleague's line. The branch follows, on its own. */
export function savedWorkLinePrefix(name: string, lang: Lang): string {
    return lang === 'fr' ? 'Travail de ' + name + ' sauvegardé sur' : 'Saved ' + name + "'s work to";
}

/** The dismiss control's label. */
export function dismissLabel(lang: Lang): string {
    return lang === 'fr' ? 'Ignorer' : 'Dismiss';
}
