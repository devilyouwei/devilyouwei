/** @format */

module.exports = {
    env: {
        node: true
    },
    extends: ['eslint:recommended', 'plugin:prettier/recommended'],
    overrides: [],
    parserOptions: {
        ecmaVersion: 'latest'
    },
    plugins: ['prettier'],
    rules: {
        'prettier/prettier': 'error'
    }
}
