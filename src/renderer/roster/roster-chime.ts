/**
 * A short, soft two-note chime, synthesized so no audio file has to load under the
 * CSP. Extracted from the vanilla roster so the React roster store can play the same
 * sound on a transition into waiting. Wrapped in try and catch: a blocked or
 * unavailable audio context must never break the view, since the badge already
 * carries the signal visually.
 */
export function playChime(): void {
    try {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        const now = ctx.currentTime;
        for (const [i, freq] of [523.25, 698.46].entries()) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            const start = now + i * 0.12;
            gain.gain.setValueAtTime(0, start);
            gain.gain.linearRampToValueAtTime(0.12, start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
            osc.connect(gain).connect(ctx.destination);
            osc.start(start);
            osc.stop(start + 0.3);
        }
        setTimeout(() => void ctx.close(), 800);
    } catch {
        // The badge is the visual half of the same signal, so a silent failure here
        // loses nothing the person cannot see.
    }
}
