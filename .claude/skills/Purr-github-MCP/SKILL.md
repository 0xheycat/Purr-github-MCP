```markdown
# Purr-github-MCP Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns and conventions used in the Purr-github-MCP JavaScript repository. It covers file organization, import/export styles, commit message habits, and testing patterns. By following these guidelines, contributors can ensure consistency and maintainability within the codebase.

## Coding Conventions

### File Naming
- Use **kebab-case** for all file names.
  - **Example:**  
    `user-profile.js`  
    `data-fetcher.test.js`

### Import Style
- Use **relative imports** for modules within the project.
  - **Example:**
    ```javascript
    import { fetchData } from './data-fetcher.js';
    ```

### Export Style
- Use **named exports** for all modules.
  - **Example:**
    ```javascript
    // In data-fetcher.js
    export function fetchData() { ... }
    ```

### Commit Messages
- Commit messages are **freeform** (no enforced structure).
- Prefixes are sometimes used, but not required.
- Average commit message length: **~33 characters**.
  - **Example:**  
    `add user profile component`  
    `fix bug in data fetcher`

## Workflows

### Adding a New Module
**Trigger:** When you need to add new functionality  
**Command:** `/add-module`

1. Create a new file in **kebab-case** (e.g., `new-feature.js`).
2. Implement your feature using **named exports**.
    ```javascript
    // new-feature.js
    export function newFeature() { ... }
    ```
3. Import your module using a **relative path** where needed.
    ```javascript
    import { newFeature } from './new-feature.js';
    ```
4. Write a corresponding test file named `new-feature.test.js`.

### Writing Tests
**Trigger:** When you add or update functionality  
**Command:** `/write-test`

1. Create a test file with the pattern `*.test.js` (e.g., `data-fetcher.test.js`).
2. Write your test cases using your preferred testing framework (framework is currently unknown).
3. Ensure all named exports are covered by tests.

### Committing Changes
**Trigger:** After making code changes  
**Command:** `/commit-changes`

1. Stage your changes.
2. Write a clear, concise commit message (~33 chars recommended).
    - Example: `update fetch logic in user module`
3. Commit your changes.

## Testing Patterns

- **Test files** use the pattern `*.test.js`.
- The testing framework is **unknown**; use your preferred tool.
- Place test files alongside the modules they test or in a dedicated test directory.
- Cover all named exports with appropriate test cases.

  **Example:**
  ```javascript
  // data-fetcher.test.js
  import { fetchData } from './data-fetcher.js';

  test('fetchData returns expected data', () => {
    // ...test implementation
  });
  ```

## Commands
| Command         | Purpose                                 |
|-----------------|-----------------------------------------|
| /add-module     | Scaffold and add a new module           |
| /write-test     | Create and write a new test file        |
| /commit-changes | Commit code changes with conventions    |
```
