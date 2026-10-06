package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsGoalAssignmentTargetEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface PmsGoalAssignmentTargetRepository extends JpaRepository<PmsGoalAssignmentTargetEntity, UUID> {

    List<PmsGoalAssignmentTargetEntity> findByAssignmentId(UUID assignmentId);

    void deleteByAssignmentId(UUID assignmentId);
}
