export interface SkillDefinition {
	name: string;
	description: string;
	steps: Array<{
		action: string;
		instruction: string;
	}>;
	tools?: string[];
	triggers?: string[];
	category?: string;
	version?: string;
}

export function defineSkill(config: SkillDefinition): SkillDefinition {
	return config;
}
