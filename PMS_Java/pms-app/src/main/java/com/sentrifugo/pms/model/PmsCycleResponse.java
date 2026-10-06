package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/** Nested cycle shape for screens 1.2-1.5, mirroring {@link PmsCycleRequest}. */
public record PmsCycleResponse(
        @JsonProperty("id") UUID id,
        @JsonProperty("cycle_code") String cycleCode,
        @JsonProperty("status") String status,
        @JsonProperty("created_on") LocalDate createdOn,
        @JsonProperty("published_on") LocalDate publishedOn,
        @JsonProperty("applicable_to") String applicableTo,
        @JsonProperty("basic") Basic basic,
        @JsonProperty("stages") List<Stage> stages,
        @JsonProperty("applicability") Applicability applicability,
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

    public record Stage(
            @JsonProperty("stage") String stage,
            @JsonProperty("start_date") LocalDate startDate,
            @JsonProperty("end_date") LocalDate endDate,
            @JsonProperty("notify") boolean notifyEnabled) {
    }

    public record Applicability(
            @JsonProperty("all_plants") boolean allPlants,
            @JsonProperty("plant_ids") List<String> plantIds,
            @JsonProperty("all_departments") boolean allDepartments,
            @JsonProperty("department_ids") List<String> departmentIds,
            @JsonProperty("employment_types") List<String> employmentTypes,
            @JsonProperty("min_service_months") Integer minServiceMonths,
            @JsonProperty("service_as_on") LocalDate serviceAsOn,
            @JsonProperty("exclude_probation") boolean excludeProbation,
            @JsonProperty("exclude_notice_period") boolean excludeNoticePeriod) {
    }

    public record Finalize(
            @JsonProperty("rating_scale_id") UUID ratingScaleId,
            @JsonProperty("notify_managers") Boolean notifyManagers,
            @JsonProperty("notify_employees") Boolean notifyEmployees,
            @JsonProperty("notify_hod") Boolean notifyHod,
            @JsonProperty("notify_hr") Boolean notifyHr) {
    }
}
