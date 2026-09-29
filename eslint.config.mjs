import tsPlugin from '@typescript-eslint/eslint-plugin';

export default tsPlugin.configs['flat/recommended'].map(config => ({
	...config,
	files: ['src/**/*.ts']
}));