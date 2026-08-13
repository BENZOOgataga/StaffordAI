/**
 * The agent definitions Stafford knows how to hire, as a runtime registry.
 *
 * The six roles live as markdown in `docs/agents/`, which Claude Code reads and
 * which are not packaged with the app. So the create flow needs its own source of
 * truth for which types are real and what each carries that Stafford reads rather
 * than Claude Code: the display title and the seniority (the frontmatter field the
 * agent README notes is read by Stafford, not by Claude Code). This is that source.
 *
 * The `type` is the definition filename. The seniorities match the frontmatter in
 * `docs/agents/`, and a create call for a type absent here is refused, so a hire
 * cannot bind to a role that does not exist.
 */

export interface AgentDefinition {
    /** The definition filename, e.g. "lead-developer". */
    readonly type: string;
    /** Display role for the card, since the definitions carry no title field. */
    readonly title: string;
    /** Read by Stafford, not Claude Code. Lower delegates to higher. */
    readonly seniority: number;
}

export const AGENT_DEFINITIONS: readonly AgentDefinition[] = [
    { type: 'pm-assistant', title: 'PM assistant', seniority: 0 },
    { type: 'lead-developer', title: 'Lead developer', seniority: 1 },
    { type: 'developer', title: 'Developer', seniority: 2 },
    { type: 'code-reviewer', title: 'Code reviewer', seniority: 2 },
    { type: 'qa-tester', title: 'QA tester', seniority: 2 },
    { type: 'writer', title: 'Writer', seniority: 2 }
];

/** The definition for a type, or null if no such definition exists. */
export function definitionFor(type: string): AgentDefinition | null {
    return AGENT_DEFINITIONS.find((d) => d.type === type) ?? null;
}
