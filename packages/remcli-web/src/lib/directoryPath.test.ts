import { describe, expect, it } from "vitest";
import { displayDirectoryPath, expandDirectoryPath } from "@/lib/directoryPath";

describe("directory path helpers", () => {
    it("round-trips Windows home paths displayed with backslash tilde prefix", () => {
        const homeDir = "C:\\Users\\Alice";
        const path = "C:\\Users\\Alice\\Projects\\remcli";

        const displayed = displayDirectoryPath(path, homeDir);

        expect(displayed).toBe("~\\Projects\\remcli");
        expect(expandDirectoryPath(displayed, homeDir)).toBe(path);
    });

    it("keeps POSIX tilde path expansion unchanged", () => {
        const homeDir = "/Users/alice";
        const path = "/Users/alice/Projects/remcli";

        const displayed = displayDirectoryPath(path, homeDir);

        expect(displayed).toBe("~/Projects/remcli");
        expect(expandDirectoryPath(displayed, homeDir)).toBe(path);
    });

    it("expands Windows tilde paths typed with forward slashes using the home separator", () => {
        expect(expandDirectoryPath("~/Projects/remcli", "C:\\Users\\Alice")).toBe("C:\\Users\\Alice\\Projects\\remcli");
    });
});
