package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;

/**
 * Screen 1.6. {@code notifications} and {@code eligibility} are read from what has been recorded for the cycle;
 * nothing records them yet (no notification or eligibility processing exists), so they are empty / null until
 * that integration is built. No counts are invented.
 */
public record PmsCycleActivationResponse(
        @JsonProperty("cycle") PmsCycleResponse cycle,
        @JsonProperty("published_on") LocalDate publishedOn,
        @JsonProperty("notifications") List<Notification> notifications,
        @JsonProperty("eligibility") Eligibility eligibility) {

    public record Notification(
            @JsonProperty("audience") String audience,
            @JsonProperty("sent") int sent,
            @JsonProperty("status") String status,
            @JsonProperty("sent_on") LocalDateTime sentOn) {
    }

    public record Eligibility(
            @JsonProperty("status") String status,
            @JsonProperty("started_on") LocalDateTime startedOn,
            @JsonProperty("completed_on") LocalDateTime completedOn,
            @JsonProperty("total_eligible") int totalEligible,
            @JsonProperty("excluded_probation") int excludedProbation,
            @JsonProperty("excluded_notice_period") int excludedNoticePeriod,
            @JsonProperty("excluded_min_service") int excludedMinService) {
    }
}
