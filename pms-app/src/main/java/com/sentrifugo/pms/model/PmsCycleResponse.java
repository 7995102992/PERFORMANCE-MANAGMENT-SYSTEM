package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.time.LocalDate;
import java.util.UUID;

/**
 * Nested cycle shape for screens 1.2-1.5. {@code stages}, {@code applicability} and {@code applicable_to} are
 * absent until their persistence model exists.
 */
public record PmsCycleResponse(
        @JsonProperty("id") UUID id,
        @JsonProperty("cycle_code") String cycleCode,
        @JsonProperty("status") String status,
        @JsonProperty("created_on") LocalDate createdOn,
        @JsonProperty("published_on") LocalDate publishedOn,
        @JsonProperty("basic") Basic basic,
        @JsonProperty("finalize") Finalize finalizeSettings,
        @JsonProperty("current_step") Integer currentStep,
        @JsonProperty("completed_step") Integer completedStep) {

    public record Basic(
            @JsonProperty("name") String name,
            @JsonProperty("description") String description,
            @JsonProperty("type") String type,
            @JsonProperty("period_start") LocalDate periodStart,
            @JsonProperty("period_end") LocalDate periodEnd) {
    }

    public record Finalize(
            @JsonProperty("rating_scale_id") UUID ratingScaleId,
            @JsonProperty("notify_managers") Boolean notifyManagers,
            @JsonProperty("notify_employees") Boolean notifyEmployees,
            @JsonProperty("notify_hod") Boolean notifyHod,
            @JsonProperty("notify_hr") Boolean notifyHr) {
    }
}
