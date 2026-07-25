"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTimeline = buildTimeline;
const STATE_ORDER = ["Pending", "Funded", "Paid"];
function buildTimeline(currentState) {
    const steps = STATE_ORDER.map((s) => {
        if (s === currentState)
            return `[ ${s} ]`;
        const idx = STATE_ORDER.indexOf(s);
        const currentIdx = STATE_ORDER.indexOf(currentState);
        if (currentIdx === -1)
            return `  ${s}  `;
        return idx < currentIdx ? `  ${s}  ` : `  ${s}  `;
    });
    const filled = steps.map((s, i) => {
        const idx = STATE_ORDER.indexOf(STATE_ORDER[i]);
        const currentIdx = STATE_ORDER.indexOf(currentState);
        if (currentIdx === -1)
            return `○ ${STATE_ORDER[i]}`;
        if (idx < currentIdx)
            return `● ${STATE_ORDER[i]}`;
        if (idx === currentIdx)
            return `◉ ${STATE_ORDER[i]}`;
        return `○ ${STATE_ORDER[i]}`;
    });
    return "\n  Timeline:  " + filled.join("  →  ") + "\n";
}
//# sourceMappingURL=status-timeline.js.map