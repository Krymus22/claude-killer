import { webRead } from "../src/apiResearcher.js";

// Fetch GitHub Actions runs
const url = "https://api.github.com/repos/Krymus22/claude-killer/actions/runs?per_page=3";
const resp = await fetch(url, {
  headers: { "Accept": "application/vnd.github+json", "User-Agent": "claude-killer" },
});
const data = await resp.json();

if (data.workflow_runs && data.workflow_runs.length > 0) {
  for (const run of data.workflow_runs) {
    console.log(`Run #${run.run_number}: ${run.conclusion ?? run.status}`);
    console.log(`  URL: ${run.html_url}`);
    console.log(`  Commit: ${run.head_commit?.message?.split("\n")[0]}`);
    console.log("");
  }

  // Get logs for the latest failed run
  const failedRun = data.workflow_runs.find(r => r.conclusion === "failure");
  if (failedRun) {
    console.log(`=== Fetching jobs for failed run ${failedRun.id} ===`);
    const jobsResp = await fetch(`https://api.github.com/repos/Krymus22/claude-killer/actions/runs/${failedRun.id}/jobs`, {
      headers: { "Accept": "application/vnd.github+json", "User-Agent": "claude-killer" },
    });
    const jobs = await jobsResp.json();
    if (jobs.jobs) {
      for (const job of jobs.jobs) {
        console.log(`\nJob: ${job.name} - ${job.conclusion}`);
        for (const step of job.steps) {
          if (step.conclusion === "failure") {
            console.log(`  FAILED step: ${step.name}`);
          }
        }
      }
    }

    // Get logs
    console.log(`\n=== Fetching logs URL ===`);
    const logsResp = await fetch(`https://api.github.com/repos/Krymus22/claude-killer/actions/runs/${failedRun.id}/logs`, {
      headers: { "Accept": "application/vnd.github+json", "User-Agent": "claude-killer" },
      redirect: "manual",
    });
    console.log(`Logs redirect: ${logsResp.status} ${logsResp.headers.get("location") ?? "no redirect"}`);
  }
} else {
  console.log("No workflow runs found");
  console.log(JSON.stringify(data, null, 2).slice(0, 500));
}

process.exit(0);
