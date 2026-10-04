package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsGoalTemplateCompetencyEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface PmsGoalTemplateCompetencyRepository extends JpaRepository<PmsGoalTemplateCompetencyEntity, UUID> {

    List<PmsGoalTemplateCompetencyEntity> findByTemplateIdOrderByDisplayOrderAsc(UUID templateId);

    void deleteByTemplateId(UUID templateId);

    boolean existsByCompetencyId(UUID competencyId);
}
