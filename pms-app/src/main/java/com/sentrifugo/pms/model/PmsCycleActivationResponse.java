package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.time.LocalDate;

/**
 * Screen 1.6. Per-audience notification counts and the eligibility-run status are deliberately absent: neither
 * the notification integration nor an eligibility-run model exists yet, and no counts are invented.
 */
public record PmsCycleActivationResponse(
        @JsonProperty("cycle") PmsCycleResponse cycle,
        @JsonProperty("published_on") LocalDate publishedOn) {
}
