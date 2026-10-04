package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsGoalTemplateCompetencyEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

public interface PmsGoalTemplateCompetencyRepository extends JpaRepository<PmsGoalTemplateCompetencyEntity, UUID> {
}
