// @flow strict-local

import type { GlobalState, PerAccountState } from './types';
import { getUsers } from './directSelectors';
import { tryGetAuth, tryGetActiveAccountState } from './account/accountsSelectors';
import { getUsersById } from './users/userSelectors';

/**
 * Whether we have server data for the active account.
 *
 * This can be used to decide whether the app's main UI which shows data
 * from the server should render itself, or should fall back to a loading
 * screen.
 *
 * See {@link getHaveServerData}.
 */
export const getHaveServerDataGlobal = (globalState: GlobalState): boolean => {
  // Any valid server data is about the active account.  So if there is no
  // active account, then any server data we appear to have can't be valid.
  const state = tryGetActiveAccountState(globalState);
  if (!state) {
    // (For background to this comment's reasoning, see getHaveServerData.)
    //
    // From `accountsReducer`:
    //  * This condition is resolved by LOGIN_SUCCESS.
    //  * It's created only by ACCOUNT_REMOVE.
    //
    // When this condition applies, LOGIN_SUCCESS is the only way we might
    // navigate to the main UI.
    //
    // ACCOUNT_REMOVE is available only from the account-picker screen (not
    // the main UI), and moreover is available for the active account only
    // when not logged in, in which case the main UI can't be on the
    // navigation stack either.
    return false;
  }

  /* eslint-disable-next-line no-use-before-define */
  return getHaveServerData(state);
};

/**
 * Whether we have server data for this account.
 *
 * See also {@link getHaveServerDataGlobal}.
 */
// Note that in our pre-#5006 model where a PerAccountState is secretly just
// GlobalState and implicitly means the active account, if there is *no*
// active account (i.e. if there are no accounts at all), then this will
// throw an exception, not return false.  If that's not desired, then the
// caller is really working with global state and should use
// `getHaveServerDataGlobal`.
export const getHaveServerData = (state: PerAccountState): boolean => {
  // The implementation has to be redundant, because upon rehydrate we can
  // unfortunately have some of our state subtrees containing server data
  // while others don't, reflecting different points in time from the last
  // time the app ran.  In particular, if the user switched accounts (so
  // that we cleared server data in Redux) and then the app promptly
  // crashed, or was killed, that clearing-out may have reached some
  // subtrees but not others.  See #4587 for an example, and #4841 overall.

  // It's important that we never stick around in a state where we're trying
  // to show the main UI but this function returns false.  When in that
  // state, we just show a loading screen with no UI, so there has to be
  // something happening in the background that will get us out of it.
  //
  // The basic strategy is:
  //  * When we start showing the main UI, we always kick off an initial
  //    fetch.  Specifically:
  //    * If at startup (upon rehydrate) we show the main UI, we do so.
  //      This is controlled by `getInitialRouteInfo`, together with
  //      `sessionReducer` as it sets `needsInitialFetch`.
  //    * When we navigate to the main UI (via `resetToMainTabs`), we always
  //      also dispatch an action that causes `needsInitialFetch` to be set.
  //    * Plus, that initial fetch has a timeout, so it will always take us
  //      away from a loading screen regardless of server/network behavior.
  //
  //  * When we had server data and we stop having it, we always also either
  //    navigate away from the main UI, or kick off a new initial fetch.
  //    Specifically:
  //    * Between this function and the reducers, we should only stop having
  //      server data upon certain actions in `accountActions`.
  //    * Some of those actions cause `needsInitialFetch` to be set, as above.
  //    * Those that don't should always be accompanied by navigating away
  //      from the main UI, with `resetToAccountPicker`.
  //
  // Ideally the decisions "should we show the loading screen" and "should
  // we kick off a fetch" would be made together in one place, so that it'd
  // be possible to confirm they align without so much nonlocal reasoning.

  // Specific facts used in the reasoning below (within the strategy above):
  //  * The actions LOGIN_SUCCESS and ACCOUNT_SWITCH cause
  //    `needsInitialFetch` to be set.
  //  * The action LOGOUT is always accompanied by navigating away from the
  //    main UI.
  //  * A successful initial fetch causes a REGISTER_COMPLETE action.  A failed one
  //    causes either LOGOUT, or an abort that ensures we're not at a
  //    loading screen.
  //
  // (The same background facts are used in getHaveServerDataGlobal, too.)

  // Any valid server data comes from the account being logged in.
  if (!tryGetAuth(state)) {
    // From `accountsReducer`:
    //  * This condition is resolved by LOGIN_SUCCESS.
    //  * It's created only by ACCOUNT_REMOVE, by LOGOUT, and by (a
    //    hypothetical) ACCOUNT_SWITCH for a logged-out account.
    //
    // When this condition applies, LOGIN_SUCCESS is the only way we might
    // navigate to the main UI.
    //
    // For ACCOUNT_REMOVE, see the previous condition.
    // ACCOUNT_SWITCH we only do for logged-in accounts.
    return false;
  }

  // Valid server data must have a user: the self user, at a minimum.
  if (getUsers(state).length === 0) {
    // From `usersReducer`:
    //  * This condition is resolved by REGISTER_COMPLETE.
    //  * It's created only by LOGIN_SUCCESS, LOGOUT, and ACCOUNT_SWITCH.
    return false;
  }

  // It must also have the self user's user ID.
  const ownUserId = state.realm.user_id;
  if (ownUserId === undefined) {
    // From `realmReducer`:
    //  * This condition is resolved by REGISTER_COMPLETE.
    //  * It's created only by LOGIN_SUCCESS, LOGOUT, and ACCOUNT_SWITCH.
    return false;
  }

  // We can also do a basic consistency check between those two subtrees:
  // the self user identified in `state.realm` is among those we have in
  // `state.users`.  (If for example the previous run of the app switched
  // accounts, and got all the way to writing the new account's
  // `state.realm` but not even clearing out `state.users` or vice versa,
  // then this check would fire.  And in that situation without this check,
  // we crash early on because `getOwnUser` fails.)
  if (!getUsersById(state).get(ownUserId)) {
    // From the reducers (and assumptions about the server's data):
    //  * This condition is resolved by REGISTER_COMPLETE.
    //  * It's never created (post-rehydrate.)
    return false;
  }

  // TODO: A nice bonus would be to check that the account matches the
  // server data, given any of:
  //  * user ID in `Account` (#4951)
  //  * realm URL in `RealmState`
  //  * delivery email in `RealmState` and/or `User` (though not sure this
  //    is available from server, even for self, in all configurations)

  // Any other subtree could also have been emptied while others weren't,
  // or otherwise be out of sync.
  //
  // But it appears that in every other subtree containing server state, the
  // empty state (i.e. the one we reset to on logout or account switch) is a
  // valid possible state.  That means (a) we can't so easily tell that it's
  // out of sync, but also (b) the app's UI is not so likely to just crash
  // from the get-go if it is -- because at least it won't crash simply
  // because the state is empty.
  //
  // There're still plenty of other ways different subtrees can be out of
  // sync with each other: `state.narrows` could know about some new message
  // that `state.messages` doesn't, or `state.messages` have a message sent
  // by a user that `state.users` has no record of.
  //
  // But given that shortly after starting to show the main app UI (whether
  // that's at startup, or after picking an account or logging in) we go
  // fetch fresh data from the server anyway, the checks above are hopefully
  // enough to let the app survive that long.
  return true;
};
