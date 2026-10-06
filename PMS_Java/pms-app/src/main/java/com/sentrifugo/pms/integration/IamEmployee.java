package com.sentrifugo.pms.integration;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * One employee as IAM returns it from {@code GET /employees/}. The explicit names keep
 * IAM's camelCase keys even though PMS serialises snake_case everywhere else.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record IamEmployee(
        @JsonProperty("userId") String userId,
        @JsonProperty("empCode") String empCode,
        @JsonProperty("firstName") String firstName,
        @JsonProperty("lastName") String lastName,
        @JsonProperty("workEmail") String workEmail,
        @JsonProperty("departmentId") String departmentId,
        @JsonProperty("designationId") String designationId,
        @JsonProperty("designationName") String designationName) {
}
