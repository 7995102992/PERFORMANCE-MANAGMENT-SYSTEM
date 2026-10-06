package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;

/** One row of screen 3.1 "My Team". {@code goal_status} is the goal-setting state for the cycle. */
public record PmsTeamMemberResponse(
        @JsonProperty("user_id") String userId,
        @JsonProperty("emp_code") String empCode,
        @JsonProperty("name") String name,
        @JsonProperty("email") String email,
        @JsonProperty("designation_id") String designationId,
        @JsonProperty("designation_name") String designationName,
        @JsonProperty("goal_status") String goalStatus) {
}
