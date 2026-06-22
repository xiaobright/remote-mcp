export function applyTextEdit(original, oldString, newString, options = {}) {
    const path = options.path ?? "file";
    if (oldString.length === 0) {
        throw new Error("old_string must not be empty.");
    }
    if (oldString === newString) {
        throw new Error("old_string and new_string are identical; refusing a no-op edit.");
    }
    const first = original.indexOf(oldString);
    if (first < 0) {
        throw new Error(`Edit did not match ${path}.`);
    }
    if (options.replaceAll) {
        let replacements = 0;
        let index = 0;
        let text = "";
        while (index < original.length) {
            const foundAt = original.indexOf(oldString, index);
            if (foundAt < 0) {
                text += original.slice(index);
                break;
            }
            text += original.slice(index, foundAt);
            text += newString;
            index = foundAt + oldString.length;
            replacements += 1;
        }
        return { text, replacements };
    }
    const second = original.indexOf(oldString, first + oldString.length);
    if (second >= 0) {
        throw new Error(`Edit matched multiple locations in ${path}. Pass replace_all=true to replace every occurrence, or provide a more specific old_string.`);
    }
    return {
        text: `${original.slice(0, first)}${newString}${original.slice(first + oldString.length)}`,
        replacements: 1,
    };
}
//# sourceMappingURL=edit.js.map