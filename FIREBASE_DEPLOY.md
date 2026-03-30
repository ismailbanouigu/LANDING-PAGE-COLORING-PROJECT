## Firebase Deploy (Hosting + Firestore)

### Local dev

```powershell
npm run dev
```

### Production (live)

Build:

```powershell
npm run build
```

Login (one time):

```powershell
npx firebase-tools login
```

Deploy Hosting + Firestore rules:

```powershell
npx firebase-tools deploy --only hosting,firestore
```

### Auth setup (Firebase Console)

- Authentication → Sign-in method → enable Google
- Firestore Database → create database (production or test)
