package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.UUID;

public record PmsStandardRatingLevelResponse(
        @JsonProperty("id") UUID id,
        @JsonProperty("label") String label,
        @JsonProperty("definition") String definition,
        @JsonProperty("colour_code") String colourCode) {
}
