package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * Screen 1.1. {@code applicable_to} is "All Plants" when the cycle covers every plant, otherwise null: plant
 * names belong to the Sentrifugo system, which PMS cannot resolve yet (ids are on the cycle detail).
 */
public record PmsCycleListResponse(
        @JsonProperty("items") List<Item> items,
        @JsonProperty("total") long total,
        @JsonProperty("summary") Summary summary) {

    public record Item(
            @JsonProperty("id") UUID id,
            @JsonProperty("cycle_code") String cycleCode,
            @JsonProperty("name") String name,
            @JsonProperty("type") String type,
            @JsonProperty("period_start") LocalDate periodStart,
            @JsonProperty("period_end") LocalDate periodEnd,
            @JsonProperty("applicable_to") String applicableTo,
            @JsonProperty("status") String status,
            @JsonProperty("created_on") LocalDate createdOn) {
    }

    public record Summary(
            @JsonProperty("all") long all,
            @JsonProperty("draft") long draft,
            @JsonProperty("active") long active,
            @JsonProperty("closed") long closed,
            @JsonProperty("cancelled") long cancelled) {
    }
}
