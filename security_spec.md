# Security Specification & Threat Model

## 1. Data Invariants
- **Identity Isolation**: A user can only access, create, update, or delete their own profile (`/users/{userId}` where `userId == request.auth.uid`).
- **Presenter Poll Ownership**: A poll (`/polls/{pollId}`) can only be created by an authenticated user where `creatorId == request.auth.uid`.
- **Poll Immutability**: The `creatorId` and `createdAt` fields of a poll are immutable after creation.
- **Poll Integrity**: Poll codes must be strictly 6 alphanumeric characters `^[A-Z0-9]{6}$`.
- **Status Progression**: Status must be one of `draft`, `active`, or `finished`.
- **Terminal State Locking**: Once a poll reaches `status == 'finished'`, its core structural definitions cannot be rewritten by non-owners.
- **Query Enforcer**: Presenters can only query their own polls (`resource.data.creatorId == request.auth.uid`). No blanket reads.

## 2. The "Dirty Dozen" Payloads

1. **Unauthenticated Poll Creation**: Attempting to create a poll without `request.auth`.
2. **Identity Spoofing**: User A creating a poll with `creatorId = "userB"`.
3. **Ghost Field Injection**: Adding an unverified admin flag `isAdmin: true` to a poll document.
4. **Invalid Code Injection**: Setting `code = "TOO_LONG_123456"`.
5. **Path ID Poisoning**: Trying to access a poll with 2KB junk character ID.
6. **Creator Mutability Attack**: Updating an existing poll to change `creatorId` to another user.
7. **Created Date Forgery**: Forging a past date or arbitrary timestamp for `createdAt`.
8. **Invalid Status Transition**: Setting `status: "unknown_hack_status"`.
9. **Foreign User Profile Modification**: User A writing to `/users/userB`.
10. **Query Scraping Without Owner Filter**: Attempting to list all polls without filtering by `creatorId`.
11. **Excessive String Payload Attack**: Setting a 5MB string for `title` or `description`.
12. **Unauthorized Deletion**: User B attempting to delete User A's poll.

## 3. Security Assertions
All 12 attacks must return `PERMISSION_DENIED` under `firestore.rules`.
