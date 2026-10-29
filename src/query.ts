// The GitHub query the board makes: one `search` over every configured
// repository and owner. Repeated `repo:` and `user:` qualifiers in one search
// are ORed by GitHub, so the whole board is a single request whatever its size.

import type { RepoEntry } from "./config.ts";

/** The pull request selection. The same fields herdr-pr-tracker reads, so a
 * pull request shows the same signals on both widgets.
 *
 * `reviewDecision` is only populated where branch protection requires a
 * review, so `latestOpinionatedReviews` and `reviewRequests` are fetched to
 * derive it everywhere else. */
const PR_FIELDS = `
      ... on PullRequest {
        number
        title
        url
        isDraft
        createdAt
        state
        mergeable
        headRefName
        reviewDecision
        reviewRequests(first: 1) { totalCount }
        latestOpinionatedReviews(first: 20) { nodes { state } }
        mergeQueueEntry { state }
        author { login }
        repository { name owner { login } }
        reviewThreads(first: $threads) {
          totalCount
          nodes {
            isResolved
            comments(last: 1) {
              nodes { author { __typename login } }
            }
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun { conclusion status }
                    ... on StatusContext { state }
                  }
                }
              }
            }
          }
        }
      }`;

export const BOARD_QUERY = `
query($q: String!, $prs: Int!, $threads: Int!) {
  search(query: $q, type: ISSUE, first: $prs) {
    issueCount
    nodes {${PR_FIELDS}
    }
  }
  rateLimit { cost remaining }
}
`;

/** Open, not archived, in any configured repository or under any configured
 * owner. `null` when nothing is configured: an unqualified search would be
 * every open pull request on GitHub. */
export function boardSearch(entries: readonly RepoEntry[]): string | null {
  if (entries.length === 0) return null;
  const scopes = entries.map((e) =>
    e.kind === "repo" ? `repo:${e.owner}/${e.name}` : `user:${e.owner}`
  );
  return `is:pr is:open archived:false ${scopes.join(" ")}`;
}

/** The `gh api graphql` arguments for one board fetch, or null with nothing
 * configured. */
export function boardArgs(
  entries: readonly RepoEntry[],
  maxPrs: number,
  threads: number,
): string[] | null {
  const q = boardSearch(entries);
  if (q == null) return null;
  return [
    "-f",
    `query=${BOARD_QUERY}`,
    "-F",
    `q=${q}`,
    "-F",
    `prs=${maxPrs}`,
    "-F",
    `threads=${threads}`,
  ];
}
