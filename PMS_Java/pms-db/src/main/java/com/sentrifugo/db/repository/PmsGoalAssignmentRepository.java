package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsGoalAssignmentEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface PmsGoalAssignmentRepository extends JpaRepository<PmsGoalAssignmentEntity, UUID> {

    Optional<PmsGoalAssignmentEntity> findByOrganisationIdAndEmployeeUserIdAndFinancialYear(
            String organisationId, String employeeUserId, String financialYear);

    /** Sheets in a given state for the HOD queue (screen 5.1). */
    List<PmsGoalAssignmentEntity> findByOrganisationIdAndFinancialYearAndStatusIn(
            String organisationId, String financialYear,
            java.util.Collection<com.sentrifugo.db.enums.PmsAssignmentStatus> statuses);

    /** Goal state of every team member in one query, for screen 3.1. */
    List<PmsGoalAssignmentEntity> findByOrganisationIdAndFinancialYearAndEmployeeUserIdIn(
            String organisationId, String financialYear, Collection<String> employeeUserIds);
}
