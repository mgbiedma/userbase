## Performance Test

Make sure no other tabs with localhost:3001 are open, then run:

```
npm run perftest
```

A browser should open to localhost:3001. Open the browser console. You should see logs indicating the test is setting up. Wait until the test is finished setting up and the following message is logged:

```
To test user <username>, input this into the console: localStorage.setItem('<username>', '<user's key>'), then sign in with password 'Test1234'.
```

Copy the entire `localStorage.setItem()` function.

Once copied, run:

```
npm start
```

A browser should open to localhost:3000 with the normal app this time. Open the browser console and paste to set the user's encryption key. Then sign in with the username and password from above. Results on the query operation will be shown in the console.