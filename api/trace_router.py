from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from api.trace_models import ThreadRunsResponse, TraceListResponse
from api.trace_store import trace_store


router = APIRouter()


@router.get(
    "/api/runs/{run_id}/trace",
    response_model=TraceListResponse,
)
async def get_run_trace(
    run_id: str,
    after_sequence: Optional[int] = Query(default=None, ge=0),
    limit: int = Query(default=1_000, ge=1, le=1_000),
) -> TraceListResponse:
    summary = await trace_store.get_run(run_id)
    if summary is None:
        raise HTTPException(status_code=404, detail="run not found")

    events_with_sentinel = await trace_store.list_events(
        run_id,
        after_sequence=after_sequence,
        limit=limit + 1,
    )
    has_more = len(events_with_sentinel) > limit
    events = events_with_sentinel[:limit]
    last_sequence = (
        events[-1].sequence
        if events
        else (after_sequence if after_sequence is not None else 0)
    )
    return TraceListResponse(
        run_id=run_id,
        events=events,
        last_sequence=last_sequence,
        has_more=has_more,
    )


@router.get(
    "/api/threads/{thread_id}/runs",
    response_model=ThreadRunsResponse,
)
async def get_thread_runs(thread_id: str) -> ThreadRunsResponse:
    return ThreadRunsResponse(
        thread_id=thread_id,
        runs=await trace_store.list_runs(thread_id),
    )
