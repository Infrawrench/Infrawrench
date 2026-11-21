// Types for sync-skill.mjs, which the skill test imports.
export declare const SKILL_ID: string;
export declare const SOURCE: string;
export declare const TARGET: string;
export declare function yamlScalar(value: string): string;
export declare function generateSkill(source?: string): Map<string, string>;
export declare function staleSkillFiles(target?: string, source?: string): string[];
