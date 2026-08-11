/**
 * Side-effect CSS imports (xterm's stylesheet) carry no types; the bundler turns
 * them into a link. This tells tsc the import is a valid module so it does not
 * fail the type check on a stylesheet it never has to understand.
 */
declare module '*.css';
