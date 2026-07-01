```markdown
# Purr-github-MCP Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns and conventions used in the `Purr-github-MCP` JavaScript repository. You'll learn how to structure code, write conventional commits, organize tests, and follow best practices for file naming, imports, and exports. This guide is designed to help contributors maintain consistency and quality across the codebase.

## Coding Conventions

### File Naming
- Use **camelCase** for file names.
  - Example: `myUtilityFunction.js`, `userProfileHandler.js`

### Import Style
- Mixed import styles are used. Both CommonJS (`require`) and ES6 (`import`) syntaxes may be present.
  - Example (ES6):
    ```js
    import myModule from './myModule';
    ```
  - Example (CommonJS):
    ```js
    const myModule = require('./myModule');
    ```

### Export Style
- Mixed export styles are used. Both `module.exports` and `export`/`export default` are present.
  - Example (ES6):
    ```js
    export default function myFunction() { ... }
    ```
  - Example (CommonJS):
    ```js
    module.exports = myFunction;
    ```

### Commit Messages
- Use **conventional commit** format.
- Prefix commit messages with `feat`.
- Keep commit messages concise (average 54 characters).
  - Example:
    ```
    feat: add user authentication middleware
    ```

## Workflows

### Adding a New Feature
**Trigger:** When implementing a new feature in the codebase  
**Command:** `/add-feature`

1. Create a new branch for your feature.
2. Use camelCase for new file names.
3. Write code using either import/export or require/module.exports as appropriate.
4. Write or update tests in files matching `*.test.*`.
5. Commit changes using the `feat` prefix and a concise message.
6. Open a pull request for review.

### Writing Tests
**Trigger:** When adding or updating tests  
**Command:** `/write-test`

1. Create or update test files using the `*.test.*` pattern.
2. Follow the same import/export conventions as the main code.
3. Ensure tests are clear and cover the intended functionality.
4. Run tests locally to verify correctness.

## Testing Patterns

- Test files follow the `*.test.*` naming pattern (e.g., `userHandler.test.js`).
- The testing framework is not explicitly specified; use the project's existing style.
- Place test files alongside the code they test or in a designated test directory.
- Example test file:
  ```js
  // userHandler.test.js
  import userHandler from './userHandler';

  describe('userHandler', () => {
    it('should process user data correctly', () => {
      // test logic here
    });
  });
  ```

## Commands
| Command        | Purpose                                   |
|----------------|-------------------------------------------|
| /add-feature   | Start the workflow for adding a new feature|
| /write-test    | Begin writing or updating tests            |
```
